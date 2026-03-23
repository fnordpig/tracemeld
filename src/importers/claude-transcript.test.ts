import { describe, it, expect } from 'vitest';
import { importClaudeTranscript } from './claude-transcript.js';
import { detectFormat } from './detect.js';

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
      return frame.name.startsWith('llm_turn:');
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
    expect(bashSpan!.values[0]).toBe(30000);
    // Bash frame should include the description
    const bashFrame = result.profile.frames[bashSpan!.frame_index];
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
      return frame.name.startsWith('llm_turn:');
    });
    expect(turnSpan).toBeDefined();

    // Check value indices: wall_ms=0, input_tokens=1, output_tokens=2, cache_read_tokens=3, cost_usd=4
    expect(turnSpan!.values[1]).toBe(1000); // input_tokens
    expect(turnSpan!.values[2]).toBe(200); // output_tokens
    expect(turnSpan!.values[3]).toBe(5000); // cache_read_tokens

    // Cost: (1000*15 + 5000*1.5 + 200*75) / 1_000_000
    const expectedCost = (1000 * 15 + 5000 * 1.5 + 200 * 75) / 1_000_000;
    expect(turnSpan!.values[4]).toBeCloseTo(expectedCost, 6);

    // Streaming: turn wall_ms should span from first to last assistant msg (2s - 1s = 1000ms)
    expect(turnSpan!.values[0]).toBe(1000);
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
      return frame.name.startsWith('Read:');
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

    const result = importClaudeTranscript(content, 'test');
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
