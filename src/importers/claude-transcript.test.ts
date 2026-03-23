import { describe, it, expect } from 'vitest';
import { importClaudeTranscript } from './claude-transcript.js';

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
});
