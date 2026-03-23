# Claude Transcript Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Claude Code JSONL session transcripts as first-class tracemeld profiles with full conversation graph, tool timing, and token cost attribution.

**Architecture:** Parse JSONL lines, group assistant messages by `requestId` into LLM turns, match `tool_use`/`tool_result` pairs for tool spans, build parent-child tree from `parentUuid`, separate Agent subagents into distinct lanes. Value types: `wall_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`.

**Tech Stack:** TypeScript, vitest for testing, follows existing importer conventions exactly.

**Spec:** `docs/superpowers/specs/2026-03-22-claude-transcript-importer-design.md`

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `src/importers/claude-transcript.ts` | Create | Importer function + types |
| `src/importers/claude-transcript.test.ts` | Create | Unit tests |
| `src/importers/types.ts` | Modify (line 4) | Add `'claude_transcript'` to ImportFormat |
| `src/importers/detect.ts` | Modify | Add JSONL detection before JSON block |
| `src/importers/import.ts` | Modify (lines 4, 10-13, 48-63) | Add import, options, switch case |
| `src/server.ts` | Modify (line 253) | Add `'claude_transcript'` to format enum |

---

### Task 1: Add `claude_transcript` to ImportFormat

**Files:**
- Modify: `src/importers/types.ts:4`

- [ ] **Step 1: Add format to union type**

In `src/importers/types.ts`, change line 4:
```typescript
export type ImportFormat = 'claude_transcript' | 'collapsed' | 'chrome_trace' | 'gecko' | 'nsight_sqlite' | 'pprof' | 'speedscope' | 'unknown';
```

- [ ] **Step 2: Build to verify no type errors**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/importers/types.ts
git commit -m "feat: add claude_transcript to ImportFormat union"
```

---

### Task 2: Write core importer with minimal test

**Files:**
- Create: `src/importers/claude-transcript.ts`
- Create: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write the failing test — minimal 3-message transcript**

Create `src/importers/claude-transcript.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal importer skeleton**

Create `src/importers/claude-transcript.ts`:
```typescript
// src/importers/claude-transcript.ts — Claude Code JSONL transcript importer
import type { ImportedProfile } from './types.js';
import type { Span, Lane, ValueType } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

// ── JSONL message types ──────────────────────────────────────────

interface TranscriptLine {
  type: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  requestId?: string;
  isSidechain?: boolean;
  message?: TranscriptMessage;
}

interface TranscriptMessage {
  role?: string;
  content?: string | ContentBlock[];
  usage?: TokenUsage;
  model?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;          // tool_use id
  name?: string;        // tool name
  input?: Record<string, unknown>;
  tool_use_id?: string; // tool_result reference
  content?: string | ContentBlock[];
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ── Options ──────────────────────────────────────────────────────

export interface ClaudeTranscriptOptions {
  /** Cost per million input tokens. Default: 15 (Opus). */
  input_cost_per_m?: number;
  /** Cost per million output tokens. Default: 75 (Opus). */
  output_cost_per_m?: number;
  /** Cost per million cache read tokens. Default: 1.5 (Opus). */
  cache_read_cost_per_m?: number;
  /** Include user_input idle spans. Default: true. */
  include_idle?: boolean;
}

// ── Value type indices (positional) ──────────────────────────────

const WALL_MS = 0;
const INPUT_TOKENS = 1;
const OUTPUT_TOKENS = 2;
const CACHE_READ_TOKENS = 3;
const COST_USD = 4;

const VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
  { key: 'input_tokens', unit: 'none', description: 'Input/prompt tokens consumed' },
  { key: 'output_tokens', unit: 'none', description: 'Output/completion tokens generated' },
  { key: 'cache_read_tokens', unit: 'none', description: 'Tokens read from prompt cache' },
  { key: 'cost_usd', unit: 'none', description: 'Estimated dollar cost' },
];

function emptyValues(): number[] {
  return [0, 0, 0, 0, 0];
}

// ── Helpers ──────────────────────────────────────────────────────

function parseTimestamp(ts: string): number {
  return new Date(ts).getTime();
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) : s;
}

function extractToolDetail(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return truncate(String(input['description'] ?? input['command'] ?? ''), 40);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
      return truncate(String(input['file_path'] ?? input['pattern'] ?? ''), 40);
    case 'Grep':
      return truncate(String(input['pattern'] ?? ''), 40);
    case 'Agent':
      return truncate(String(input['description'] ?? input['prompt'] ?? '').slice(0, 40), 40);
    default:
      return '';
  }
}

function extractUserText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return truncate(content, 40);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) return truncate(block.text, 40);
    }
  }
  return '';
}

// ── Main importer ────────────────────────────────────────────────

export function importClaudeTranscript(
  content: string,
  name: string,
  options?: ClaudeTranscriptOptions,
): ImportedProfile {
  const inputCostPerM = options?.input_cost_per_m ?? 15;
  const outputCostPerM = options?.output_cost_per_m ?? 75;
  const cacheReadCostPerM = options?.cache_read_cost_per_m ?? 1.5;
  const includeIdle = options?.include_idle ?? true;

  // Phase 1: Parse JSONL
  const lines: TranscriptLine[] = [];
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    try {
      lines.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      // Skip malformed lines
    }
  }

  if (lines.length === 0) {
    throw new Error('Empty or invalid Claude transcript');
  }

  const frameTable = new FrameTable();
  let spanId = 0;
  const nextSpanId = () => `ct_${spanId++}`;

  // Phase 2: Group assistant messages by requestId → LLM turns
  interface LlmTurn {
    requestId: string;
    firstTs: number;
    lastTs: number;
    toolUses: ContentBlock[];
    usage: TokenUsage | null;
    parentUuid: string | null;
  }

  const turnMap = new Map<string, LlmTurn>();
  const lineByUuid = new Map<string, TranscriptLine>();

  for (const line of lines) {
    lineByUuid.set(line.uuid, line);
    if (line.type !== 'assistant' || !line.requestId) continue;

    const ts = parseTimestamp(line.timestamp);
    let turn = turnMap.get(line.requestId);
    if (!turn) {
      turn = {
        requestId: line.requestId,
        firstTs: ts,
        lastTs: ts,
        toolUses: [],
        usage: null,
        parentUuid: line.parentUuid,
      };
      turnMap.set(line.requestId, turn);
    }
    if (ts < turn.firstTs) turn.firstTs = ts;
    if (ts > turn.lastTs) turn.lastTs = ts;

    // Collect tool_use blocks
    const msg = line.message;
    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          turn.toolUses.push(block);
        }
      }
    }

    // Keep the last usage (final streaming chunk has the totals)
    if (msg?.usage) {
      turn.usage = msg.usage;
    }
  }

  // Phase 3: Build tool_use_id → tool_result timestamp map
  const toolResultTs = new Map<string, number>();
  for (const line of lines) {
    if (line.type !== 'user') continue;
    const msg = line.message;
    if (!msg?.content || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        toolResultTs.set(block.tool_use_id, parseTimestamp(line.timestamp));
      }
    }
  }

  // Phase 4: Build spans
  const mainSpans: Span[] = [];
  const agentLanes = new Map<string, { lane: Lane; spans: Span[] }>();

  // Sort turns by first timestamp
  const sortedTurns = [...turnMap.values()].sort((a, b) => a.firstTs - b.firstTs);

  // Session root span
  const sessionStart = lines.length > 0 ? parseTimestamp(lines[0].timestamp) : 0;
  const sessionEnd = lines.length > 0 ? parseTimestamp(lines[lines.length - 1].timestamp) : 0;
  const sessionFrameIdx = frameTable.getOrInsert({
    name: `session:${name}`,
  });
  const sessionSpanId = nextSpanId();
  const sessionValues = emptyValues();
  sessionValues[WALL_MS] = sessionEnd - sessionStart;
  const sessionSpan: Span = {
    id: sessionSpanId,
    frame_index: sessionFrameIdx,
    parent_id: null,
    start_time: sessionStart,
    end_time: sessionEnd,
    values: sessionValues,
    args: { sessionId: lines[0].sessionId },
    children: [],
  };
  mainSpans.push(sessionSpan);

  // User input idle spans + LLM turn spans
  let lastTurnEnd = sessionStart;

  for (const turn of sortedTurns) {
    // User input gap (idle span)
    if (includeIdle && turn.firstTs > lastTurnEnd + 100) {
      // Find the user message that triggered this turn
      let userText = '';
      if (turn.parentUuid) {
        const parentLine = lineByUuid.get(turn.parentUuid);
        if (parentLine?.type === 'user') {
          userText = extractUserText(parentLine.message?.content);
        }
      }

      const idleFrameIdx = frameTable.getOrInsert({
        name: `user_input:${userText || 'waiting'}`,
      });
      const idleId = nextSpanId();
      const idleValues = emptyValues();
      idleValues[WALL_MS] = turn.firstTs - lastTurnEnd;
      const idleSpan: Span = {
        id: idleId,
        frame_index: idleFrameIdx,
        parent_id: sessionSpanId,
        start_time: lastTurnEnd,
        end_time: turn.firstTs,
        values: idleValues,
        args: {},
        children: [],
      };
      mainSpans.push(idleSpan);
      sessionSpan.children.push(idleId);
    }

    // LLM turn span
    const turnFrameIdx = frameTable.getOrInsert({
      name: `llm_turn:${turn.requestId.slice(0, 16)}`,
    });
    const turnSpanId = nextSpanId();
    const turnValues = emptyValues();
    turnValues[WALL_MS] = turn.lastTs - turn.firstTs;

    if (turn.usage) {
      const inputTok = turn.usage.input_tokens ?? 0;
      const outputTok = turn.usage.output_tokens ?? 0;
      const cacheRead = turn.usage.cache_read_input_tokens ?? 0;
      turnValues[INPUT_TOKENS] = inputTok;
      turnValues[OUTPUT_TOKENS] = outputTok;
      turnValues[CACHE_READ_TOKENS] = cacheRead;
      turnValues[COST_USD] =
        (inputTok * inputCostPerM + cacheRead * cacheReadCostPerM + outputTok * outputCostPerM) /
        1_000_000;
    }

    const turnSpan: Span = {
      id: turnSpanId,
      frame_index: turnFrameIdx,
      parent_id: sessionSpanId,
      start_time: turn.firstTs,
      end_time: turn.lastTs,
      values: turnValues,
      args: {},
      children: [],
    };
    mainSpans.push(turnSpan);
    sessionSpan.children.push(turnSpanId);

    // Tool call spans nested under this turn
    for (const toolUse of turn.toolUses) {
      if (!toolUse.id || !toolUse.name) continue;

      const resultTs = toolResultTs.get(toolUse.id);
      const toolStart = turn.firstTs; // tool_use emitted at turn time
      const toolEnd = resultTs ?? turn.lastTs;

      const detail = extractToolDetail(toolUse.name, toolUse.input ?? {});
      const frameName = detail ? `${toolUse.name}:${detail}` : toolUse.name;
      const toolFrameIdx = frameTable.getOrInsert({ name: frameName });

      const toolSpanId = nextSpanId();
      const toolValues = emptyValues();
      toolValues[WALL_MS] = toolEnd - toolStart;

      const toolSpan: Span = {
        id: toolSpanId,
        frame_index: toolFrameIdx,
        parent_id: turnSpanId,
        start_time: toolStart,
        end_time: toolEnd,
        values: toolValues,
        args: {},
        children: [],
      };
      mainSpans.push(toolSpan);
      turnSpan.children.push(toolSpanId);

      // Update turn end time to include tool execution
      if (toolEnd > turnSpan.end_time) {
        turnSpan.end_time = toolEnd;
        turnSpan.values[WALL_MS] = turnSpan.end_time - turnSpan.start_time;
      }
    }

    lastTurnEnd = turnSpan.end_time;
  }

  // Phase 5: Build lanes
  const mainLane: Lane = {
    id: 'main',
    name: 'main',
    kind: 'main',
    samples: [],
    spans: mainSpans,
    markers: [],
  };

  const allLanes: Lane[] = [mainLane, ...([...agentLanes.values()].map((a) => a.lane))];

  return {
    format: 'claude_transcript',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: [...VALUE_TYPES],
      categories: [],
      frames: [...frameTable.frames],
      lanes: allLanes,
      metadata: {
        source_format: 'claude_transcript',
        session_id: lines[0].sessionId,
        turn_count: turnMap.size,
        tool_call_count: [...turnMap.values()].reduce((sum, t) => sum + t.toolUses.length, 0),
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importers/claude-transcript.ts src/importers/claude-transcript.test.ts
git commit -m "feat: claude transcript importer with minimal test"
```

---

### Task 3: Add tool call timing test

**Files:**
- Modify: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write test for tool_use → tool_result timing**

Add to test file:
```typescript
  it('computes tool call wall_ms from tool_use to tool_result timestamps', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'run a command' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool1',
            name: 'Bash',
            input: { command: 'cargo test', description: 'Run tests' },
          }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:31.000Z',
        uuid: 'u2', parentUuid: 'a1', sessionId: 's1',
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
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/importers/claude-transcript.test.ts
git commit -m "test: tool call timing for claude transcript importer"
```

---

### Task 4: Add token usage and cost attribution test

**Files:**
- Modify: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write test for token attribution on LLM turn spans**

Add to test file:
```typescript
  it('attributes token usage and cost to LLM turn spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:02.000Z',
        uuid: 'a2', parentUuid: 'a1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: ' there!' }],
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:10.000Z',
        uuid: 'u2', parentUuid: 'a2', sessionId: 's1',
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
    expect(turnSpan!.values[1]).toBe(1000);  // input_tokens
    expect(turnSpan!.values[2]).toBe(200);   // output_tokens
    expect(turnSpan!.values[3]).toBe(5000);  // cache_read_tokens

    // Cost: (1000*15 + 5000*1.5 + 200*75) / 1_000_000
    const expectedCost = (1000 * 15 + 5000 * 1.5 + 200 * 75) / 1_000_000;
    expect(turnSpan!.values[4]).toBeCloseTo(expectedCost, 6);

    // Streaming: turn wall_ms should span from first to last assistant msg
    expect(turnSpan!.values[0]).toBe(1000); // 2s - 1s = 1000ms
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/importers/claude-transcript.test.ts
git commit -m "test: token usage and cost attribution for claude transcript"
```

---

### Task 5: Add parallel tool calls test

**Files:**
- Modify: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write test for multiple tool_use in one assistant message**

Add to test file:
```typescript
  it('handles parallel tool calls as sibling spans', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'check files' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
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
        uuid: 'u2', parentUuid: 'a1', sessionId: 's1',
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

    // Find tool spans
    const toolSpans = mainLane.spans.filter((s) => {
      const frame = result.profile.frames[s.frame_index];
      return frame.name.startsWith('Read:');
    });
    expect(toolSpans.length).toBe(2);

    // Both should be children of the same LLM turn
    expect(toolSpans[0].parent_id).toBe(toolSpans[1].parent_id);
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/importers/claude-transcript.test.ts
git commit -m "test: parallel tool calls in claude transcript"
```

---

### Task 6: Add user_input idle span test

**Files:**
- Modify: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write test for idle spans between turns**

Add to test file:
```typescript
  it('creates user_input idle spans between turns', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'first question' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:05:00.000Z',
        uuid: 'u2', parentUuid: 'a1', sessionId: 's1',
        message: { role: 'user', content: 'second question' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:05:01.000Z',
        uuid: 'a2', parentUuid: 'u2', requestId: 'req2', sessionId: 's1',
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

    // The idle span should capture the 5-minute gap
    const gap = idleSpans.find((s) => s.values[0] > 200000); // > 200s
    expect(gap).toBeDefined();
  });

  it('excludes idle spans when include_idle is false', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:05:00.000Z',
        uuid: 'u2', parentUuid: 'a1', sessionId: 's1',
        message: { role: 'user', content: 'bye' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:05:01.000Z',
        uuid: 'a2', parentUuid: 'u2', requestId: 'req2', sessionId: 's1',
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
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/importers/claude-transcript.test.ts
git commit -m "test: user_input idle spans and include_idle option"
```

---

### Task 7: Wire into detection and dispatch

**Files:**
- Modify: `src/importers/detect.ts`
- Modify: `src/importers/import.ts:4,10-13,48-63`
- Modify: `src/server.ts:253`

- [ ] **Step 1: Write detection test**

Add to `src/importers/claude-transcript.test.ts`:
```typescript
import { detectFormat } from './detect.js';

// ... inside describe block:
  it('detects claude transcript format from JSONL', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'hello' },
      },
    ]);
    expect(detectFormat(content)).toBe('claude_transcript');
  });

  it('does not mis-detect regular JSONL as claude transcript', () => {
    const content = '{"name":"foo","value":1}\n{"name":"bar","value":2}\n';
    expect(detectFormat(content)).not.toBe('claude_transcript');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: FAIL — detectFormat returns 'unknown' for JSONL

- [ ] **Step 3: Add JSONL detection to detect.ts**

In `src/importers/detect.ts`, add before the JSON block (after line 8):
```typescript
  // Try JSONL (Claude transcript): first line is JSON with sessionId + type
  if (!trimmed.startsWith('[') && trimmed.startsWith('{')) {
    const firstNewline = trimmed.indexOf('\n');
    const firstLine = firstNewline > 0 ? trimmed.slice(0, firstNewline) : trimmed;
    try {
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      if (typeof obj['sessionId'] === 'string' && typeof obj['type'] === 'string' &&
          ['user', 'assistant', 'system'].includes(obj['type'] as string)) {
        return 'claude_transcript';
      }
    } catch {
      // Not valid JSON first line, continue
    }
  }
```

- [ ] **Step 4: Add to import.ts dispatcher**

In `src/importers/import.ts`:

Add import at top:
```typescript
import { importClaudeTranscript, type ClaudeTranscriptOptions } from './claude-transcript.js';
```

Add to `ImportOptions` interface:
```typescript
  /** Options passed to the Claude transcript importer. */
  claude_transcript?: ClaudeTranscriptOptions;
```

Add to `runImporter` switch:
```typescript
    case 'claude_transcript':
      return importClaudeTranscript(content, name, options?.claude_transcript);
```

- [ ] **Step 5: Add to server.ts format enum**

In `src/server.ts` line 253, add `'claude_transcript'` to the enum:
```typescript
format: z.enum(['auto', 'claude_transcript', 'collapsed', 'chrome_trace', 'gecko', 'pprof', 'speedscope', 'nsight_sqlite']).optional(),
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 8: Commit**

```bash
git add src/importers/detect.ts src/importers/import.ts src/importers/claude-transcript.test.ts src/server.ts
git commit -m "feat: wire claude transcript importer into detection and dispatch"
```

---

### Task 8: Integration test with real transcript

**Files:**
- Modify: `src/importers/claude-transcript.test.ts`

- [ ] **Step 1: Write integration test**

Add to test file:
```typescript
import { importProfile } from './import.js';
import { ProfileBuilder } from '../model/profile.js';

// ... inside describe block:
  it('integrates via importProfile and merges into ProfileBuilder', () => {
    const content = makeTranscript([
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:00.000Z',
        uuid: 'u1', parentUuid: null, sessionId: 's1',
        message: { role: 'user', content: 'do something' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-16T02:00:01.000Z',
        uuid: 'a1', parentUuid: 'u1', requestId: 'req1', sessionId: 's1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', id: 't1', name: 'Bash',
            input: { command: 'echo hi', description: 'Print hi' },
          }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500 },
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-16T02:00:05.000Z',
        uuid: 'u2', parentUuid: 'a1', sessionId: 's1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }],
        },
      },
    ]);

    const builder = new ProfileBuilder('integration-test');
    const result = importProfile(content, 'test-session', 'auto', builder);

    expect(result.format_detected).toBe('claude_transcript');
    expect(result.spans_added).toBeGreaterThan(0);
    expect(result.value_types).toContain('wall_ms');
    expect(result.value_types).toContain('input_tokens');
    expect(result.value_types).toContain('cost_usd');
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/importers/claude-transcript.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/importers/claude-transcript.test.ts
git commit -m "test: integration test for claude transcript via importProfile"
```

---

### Task 9: Bump version and ship

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Run full test suite and build**

Run: `npm test && npm run build`
Expected: All tests pass, clean build

- [ ] **Step 2: Bump version**

In `package.json`, bump version from `0.1.10` to `0.1.11`.

- [ ] **Step 3: Commit, tag, push**

```bash
git add -A
git commit -m "feat: claude code transcript importer (claude_transcript format)"
git tag v0.1.11
git push origin main --tags
```
