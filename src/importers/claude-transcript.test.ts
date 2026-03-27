import { describe, it, expect } from 'vitest';
import { importClaudeTranscript } from './claude-transcript.js';
import { detectFormat } from './detect.js';
import { importProfile } from './import.js';
import { ProfileBuilder } from '../model/profile.js';

function makeTranscript(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('importClaudeTranscript', () => {
  it('parses a minimal user-assistant-user transcript', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'sess1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 'sess1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:05.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 'sess1',
        message: { role: 'user', content: 'thanks' },
      },
    ]);

    const result = importClaudeTranscript(content, 'test-session');
    expect(result.format).toBe('claude_transcript');
    expect(result.profile.lanes.length).toBeGreaterThanOrEqual(1);

    // Should have at least one LLM turn span
    const mainLane = result.profile.lanes[0];
    const llmSpans = mainLane.spans.filter((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('turn:');
    });
    expect(llmSpans.length).toBe(1);

    // Value types should include token dimensions
    const vtKeys = result.profile.value_types.map((vt) => vt.key);
    expect(vtKeys).toContain('wall_ms');
    expect(vtKeys).toContain('input_tokens');
    expect(vtKeys).toContain('output_tokens');
  });

  it('computes tool call wall_ms from tool_use to tool_result timestamps', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'run a command' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool1',
              name: 'Bash',
              input: { command: 'cargo test', description: 'Run tests' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:31.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'ok' }],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    // Find the Bash tool span
    const bashSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('Bash:');
    });
    expect(bashSpan).toBeDefined();
    // tool_use at T+1s, tool_result at T+31s = 30000ms
    expect(bashSpan?.values[0]).toBe(30000);
    // Bash frame should include the description
    const bashFrame = result.profile.frames[bashSpan?.frame_index ?? 0];
    expect(bashFrame.name).toBe('Bash:Run tests');
  });

  it('attributes token usage and cost to LLM turn spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'a2',
        parentUuid: 'a1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: ' there!' }],
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:10.000Z',
        uuid: 'u2',
        parentUuid: 'a2',
        sessionId: 's1',
        message: { role: 'user', content: 'bye' },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    // Find the LLM turn span
    const turnSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('turn:');
    });
    expect(turnSpan).toBeDefined();

    // Check value indices: wall_ms=0, input_tokens=1, output_tokens=2, cache_read_tokens=3, cost_usd=4
    expect(turnSpan?.values[1]).toBe(1000); // input_tokens
    expect(turnSpan?.values[2]).toBe(200); // output_tokens
    expect(turnSpan?.values[3]).toBe(5000); // cache_read_tokens

    // Cost: (1000*15 + 5000*1.5 + 200*75) / 1_000_000
    const expectedCost = (1000 * 15 + 5000 * 1.5 + 200 * 75) / 1_000_000;
    expect(turnSpan?.values[4]).toBeCloseTo(expectedCost, 6);

    // Streaming: turn wall_ms should span from first to last assistant msg (2s - 1s = 1000ms)
    expect(turnSpan?.values[0]).toBe(1000);
  });

  it('handles parallel tool calls as sibling spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'check files' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b.ts' } },
          ],
          usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file a' },
            { type: 'tool_result', tool_use_id: 't2', content: 'file b' },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    // Find Read tool spans
    const toolSpans = mainLane.spans.filter((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('file_read:');
    });
    expect(toolSpans.length).toBe(2);

    // Both should be children of the same LLM turn (same parent_id)
    expect(toolSpans[0].parent_id).toBe(toolSpans[1].parent_id);
  });

  it('creates user_input idle spans between turns', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'first question' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:05:00.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: { role: 'user', content: 'second question' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:05:01.000Z',
        uuid: 'a2',
        parentUuid: 'u2',
        requestId: 'req2',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer 2' }],
          usage: { input_tokens: 80, output_tokens: 15, cache_read_input_tokens: 0 },
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test', { include_idle: true });
    const mainLane = result.profile.lanes[0];

    // Find idle spans
    const idleSpans = mainLane.spans.filter((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('user_input:');
    });
    expect(idleSpans.length).toBeGreaterThanOrEqual(1);

    // The idle span should capture the 5-minute gap (> 200s = 200000ms)
    const gap = idleSpans.find((s) => s.values[0] > 200000);
    expect(gap).toBeDefined();
  });

  it('importProfile pipeline: auto-detects, imports, and returns correct metadata', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'test-session',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 'test-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'echo hi', description: 'Print hi' },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:03.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 'test-session',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }],
        },
      },
    ]);

    const builder = new ProfileBuilder('test-session');
    const result = importProfile(content, 'test-session', 'auto', builder);

    expect(result.format_detected).toBe('claude_transcript');
    expect(result.spans_added).toBeGreaterThan(0);
    expect(result.value_types).toContain('wall_ms');
    expect(result.value_types).toContain('input_tokens');
    expect(result.value_types).toContain('cost_usd');
  });

  it('has 8 value types including cache_creation, input_chars, and result_chars', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const vtKeys = result.profile.value_types.map((vt) => vt.key);
    expect(vtKeys).toEqual([
      'wall_ms',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cost_usd',
      'cache_creation_tokens',
      'input_chars',
      'result_chars',
    ]);
    expect(result.profile.value_types.length).toBe(8);

    // All spans should have 8 values
    for (const span of result.profile.lanes[0].spans) {
      expect(span.values.length).toBe(8);
    }
  });

  it('populates input_chars and result_chars on tool spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'read a file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/src/main.ts' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'const x = 42;\nexport default x;\n',
            },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    // Find the file_read tool span
    const toolSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('file_read:');
    });
    expect(toolSpan).toBeDefined();
    if (!toolSpan) return;

    // input_chars = length of JSON.stringify({ file_path: '/src/main.ts' })
    const expectedInputChars = JSON.stringify({ file_path: '/src/main.ts' }).length;
    expect(toolSpan.values[6]).toBe(expectedInputChars);

    // result_chars = length of 'const x = 42;\nexport default x;\n'
    expect(toolSpan.values[7]).toBe('const x = 42;\nexport default x;\n'.length);
  });

  it('populates cache_creation_tokens on turn spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 3000,
          },
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    const turnSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('turn:');
    });
    expect(turnSpan).toBeDefined();
    if (!turnSpan) return;
    expect(turnSpan.values[5]).toBe(3000); // cache_creation_tokens at index 5

    // Cost should include cache creation: (100*15 + 500*1.5 + 3000*3.75 + 20*75) / 1_000_000
    const expectedCost = (100 * 15 + 500 * 1.5 + 3000 * 3.75 + 20 * 75) / 1_000_000;
    expect(turnSpan.values[4]).toBeCloseTo(expectedCost, 6);
  });

  it('enriches tool span args from toolUseResult metadata', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'read a file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'echo hello', description: 'Print hello' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        toolUseResult: { stdout: 'hello\n', interrupted: false },
        sourceToolAssistantUUID: 'a1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello\n' }],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    const bashSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('Bash:');
    });
    expect(bashSpan).toBeDefined();
    if (!bashSpan) return;
    expect(bashSpan.args.stdout_size).toBe(6); // 'hello\n'.length
    // interrupted is falsy, so it should not be set
    expect(bashSpan.args.interrupted).toBeUndefined();
  });

  it('sets file_path from TUR and uses it in frame name', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'read a file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/src/foo.ts' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        toolUseResult: { filePath: '/src/foo.ts' },
        sourceToolAssistantUUID: 'a1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    const readSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('file_read:');
    });
    expect(readSpan).toBeDefined();
    if (!readSpan) return;
    expect(readSpan.args.file_path).toBe('/src/foo.ts');

    // Frame name should use file_read kind
    const frame = result.profile.frames[readSpan.frame_index];
    expect(frame.name).toBe('file_read:/src/foo.ts');
  });

  it('uses turn: and file_read:/file_write: frame name conventions', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'edit a file' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/b.ts' } },
            { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/c.ts' } },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
            { type: 'tool_result', tool_use_id: 't3', content: 'file c' },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const frames = result.profile.frames;
    const mainLane = result.profile.lanes[0];

    // Turn frame should use 'turn:' prefix
    const turnSpan = mainLane.spans.find((s) => frames[s.frame_index].name.startsWith('turn:'));
    expect(turnSpan).toBeDefined();

    // Edit/Write should use 'file_write:' prefix
    const writeSpans = mainLane.spans.filter((s) =>
      frames[s.frame_index].name.startsWith('file_write:'),
    );
    expect(writeSpans.length).toBe(2); // Edit and Write both map to file_write

    // Read should use 'file_read:' prefix
    const readSpans = mainLane.spans.filter((s) =>
      frames[s.frame_index].name.startsWith('file_read:'),
    );
    expect(readSpans.length).toBe(1);
  });

  it('captures tool errors from is_error tool_results', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'run a command' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'exit 1', description: 'Fail' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: 'Command failed with exit code 1',
            },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    const bashSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('Bash:');
    });
    expect(bashSpan).toBeDefined();
    if (!bashSpan) return;
    expect(bashSpan.error).toBe('Command failed with exit code 1');
  });

  it('gracefully degrades when toolUseResult is absent', () => {
    // No TUR fields on any line — should still work
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'run a command' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/some/file.ts' },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file content here' },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    // Should still create the tool span with file_read prefix
    const readSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('file_read:');
    });
    expect(readSpan).toBeDefined();
    if (!readSpan) return;
    // Args should be empty (no TUR)
    expect(Object.keys(readSpan.args).length).toBe(0);
    // No error
    expect(readSpan.error).toBeUndefined();
    // result_chars should still be populated from tool_result content
    expect(readSpan.values[7]).toBe('file content here'.length);
  });

  it('populates result_chars from array tool_result content blocks', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'read something' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'file1.ts\n' },
                { type: 'text', text: 'file2.ts\n' },
              ],
            },
          ],
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test');
    const mainLane = result.profile.lanes[0];

    const bashSpan = mainLane.spans.find((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('Bash:');
    });
    expect(bashSpan).toBeDefined();
    if (!bashSpan) return;
    // 'file1.ts\n'.length + 'file2.ts\n'.length = 9 + 9 = 18
    expect(bashSpan.values[7]).toBe(18);
  });

  it('excludes idle spans when include_idle is false', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:05:00.000Z',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        message: { role: 'user', content: 'bye' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:05:01.000Z',
        uuid: 'a2',
        parentUuid: 'u2',
        requestId: 'req2',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'goodbye' }],
          usage: { input_tokens: 80, output_tokens: 15, cache_read_input_tokens: 0 },
        },
      },
    ]);

    const result = importClaudeTranscript(content, 'test', { include_idle: false });
    const mainLane = result.profile.lanes[0];

    const idleSpans = mainLane.spans.filter((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('user_input:');
    });
    expect(idleSpans.length).toBe(0);
  });
});

describe('detectFormat – claude_transcript', () => {
  it('detects JSONL with sessionId and type as claude_transcript', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'sess1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1',
        parentUuid: 'u1',
        requestId: 'req1',
        sessionId: 'sess1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    expect(detectFormat(content)).toBe('claude_transcript');
  });

  it('does not detect regular JSONL without sessionId', () => {
    const content = [
      JSON.stringify({ type: 'event', data: 'something' }),
      JSON.stringify({ type: 'event', data: 'other' }),
    ].join('\n');
    expect(detectFormat(content)).not.toBe('claude_transcript');
  });

  it('does not detect a Chrome trace JSON object as claude_transcript', () => {
    const content = JSON.stringify({
      traceEvents: [{ ph: 'B', name: 'foo', ts: 0, pid: 1, tid: 1 }],
    });
    expect(detectFormat(content)).toBe('chrome_trace');
  });
});

describe('reduce-session ontology integration', () => {
  it('populates reduction metadata when _reduce tags are present', () => {
    const lines = [
      { type: 'system', uuid: 's1', parentUuid: null, sessionId: 'sess1', timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'system', content: 'You are Claude.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 's1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:01Z',
        requestId: 'req1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 100, output_tokens: 50 } },
        _reduce: { v: 1, structural: true, cls: 'IMPLEMENTATION', route: 'DISTILL' } },
      { type: 'user', uuid: 'u1', parentUuid: 'a1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:02Z',
        message: { role: 'user', content: 'ok' },
        _reduce: { v: 1, structural: true, cls: 'INSTRUCTION', route: 'KEEP' } },
    ];
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    const result = importClaudeTranscript(content, 'test');

    const meta = result.profile.metadata;
    const reduction = meta.reduction as Record<string, unknown>;
    expect(reduction).toBeDefined();
    expect(reduction.coverage_pct).toBe(67); // 2 of 3 lines
    expect(reduction.classified_pct).toBe(67);
    expect((reduction.routes as Record<string, number>).DISTILL).toBe(1);
    expect((reduction.routes as Record<string, number>).KEEP).toBe(1);
    expect((reduction.classes as Record<string, number>).IMPLEMENTATION).toBe(1);
    expect((reduction.classes as Record<string, number>).INSTRUCTION).toBe(1);
  });

  it('populates turn span args with ontology class', () => {
    const lines = [
      { type: 'system', uuid: 's1', parentUuid: null, sessionId: 'sess1', timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'system', content: 'You are Claude.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 's1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:01Z',
        requestId: 'req1', message: { role: 'assistant', content: [{ type: 'text', text: 'implementing...' }],
          usage: { input_tokens: 100, output_tokens: 50 } },
        _reduce: { v: 1, cls: 'IMPLEMENTATION', route: 'DISTILL', distilled: true } },
      { type: 'user', uuid: 'u1', parentUuid: 'a1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:02Z',
        message: { role: 'user', content: 'next' } },
    ];
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    const result = importClaudeTranscript(content, 'test');

    // Find the turn span
    const turnSpan = result.profile.lanes[0].spans.find(s =>
      result.profile.frames[s.frame_index]?.name.startsWith('turn:'));
    expect(turnSpan).toBeDefined();
    if (!turnSpan) return;
    expect(turnSpan.args.ontology_class).toBe('IMPLEMENTATION');
    expect(turnSpan.args.reduce_route).toBe('DISTILL');
    expect(turnSpan.args.distilled).toBe(true);
  });

  it('omits reduction metadata when no _reduce tags present', () => {
    const lines = [
      { type: 'system', uuid: 's1', parentUuid: null, sessionId: 'sess1', timestamp: '2025-01-01T00:00:00Z',
        message: { role: 'system', content: 'You are Claude.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 's1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:01Z',
        requestId: 'req1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: 'user', uuid: 'u1', parentUuid: 'a1', sessionId: 'sess1', timestamp: '2025-01-01T00:00:02Z',
        message: { role: 'user', content: 'bye' } },
    ];
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    const result = importClaudeTranscript(content, 'test');
    const meta = result.profile.metadata;
    expect(meta.reduction).toBeUndefined();
  });
});
