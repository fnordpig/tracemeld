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
  id?: string; // tool_use id
  name?: string; // tool name
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
      return truncate(String(input['description'] ?? input['prompt'] ?? ''), 40);
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
  const sessionStart = parseTimestamp(lines[0].timestamp);
  const sessionEnd = parseTimestamp(lines[lines.length - 1].timestamp);
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

  const allLanes: Lane[] = [mainLane, ...[...agentLanes.values()].map((a) => a.lane)];

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
