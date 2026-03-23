# Claude Code Transcript Importer

**Date**: 2026-03-22
**Status**: Design

## Problem

Claude Code sessions produce JSONL transcripts with timestamps, tool calls, token usage, and conversation structure. To analyze session performance (which turns were expensive, which tools were slow, where tokens were wasted), this data needs to be imported into tracemeld's profile model. Currently this requires ad-hoc Python scripts that lose most of the structure.

## Format

Claude Code transcripts are JSONL files where each line is a JSON object with:

- `type`: `"user"` | `"assistant"` | `"progress"` | `"system"` | `"queue-operation"` | `"file-history-snapshot"`
- `message`: Contains `role`, `content` (array of text/tool_use/tool_result blocks), `usage` (token counts)
- `timestamp`: ISO 8601
- `uuid`: Unique message ID
- `parentUuid`: Links to parent message (forms a tree)
- `requestId`: Groups streaming chunks of a single LLM response
- `sessionId`: Session identifier
- `isSidechain`: Boolean, true for branched/agent conversations

Typical session: 500-10,000 lines, 100-3000 tool calls, spanning minutes to days.

## Mapping to Tracemeld Model

### Spans

| Transcript concept | Span kind | Parent | Wall time source |
|---|---|---|---|
| Full session | `session` | root | First to last timestamp |
| LLM turn (requestId group) | `llm_turn` | session or user_input | First to last assistant msg with that requestId |
| Tool call | Tool name (e.g. `Bash`, `Edit`, `Read`) | llm_turn | tool_use timestamp → tool_result timestamp |
| User input gap | `user_input` | session | Last assistant msg → next user msg |

### Value Types

| Key | Unit | Source |
|---|---|---|
| `wall_ms` | milliseconds | Timestamp deltas |
| `input_tokens` | none | `usage.input_tokens` on final assistant msg per requestId |
| `output_tokens` | none | `usage.output_tokens` on final assistant msg per requestId |
| `cache_read_tokens` | none | `usage.cache_read_input_tokens` |
| `cost_usd` | none | Computed: `(input_tokens * 15 + cache_read_tokens * 1.5 + output_tokens * 75) / 1_000_000` (Opus pricing) |

Token values go on the `llm_turn` span. Tool spans get only `wall_ms`.

### Lanes

- **Main lane**: Sequential flow of LLM turns, tool calls, and user input gaps
- **Agent lanes**: One per distinct Agent subagent invocation, detected by `isSidechain: true` or Agent tool_use/result pairs containing nested tool calls

### Frames

Frame names follow `{kind}:{detail}` convention:
- `llm_turn:req_011CZ5xM` (truncated requestId)
- `Bash:cargo test` (tool name : first 40 chars of command/description)
- `Edit:src/main.rs` (tool name : file path)
- `Read:src/lib.rs` (tool name : file path)
- `user_input:fix the build error` (first 40 chars of user message)
- `Agent:Explore codebase` (agent description)

### Parent-Child Reconstruction

The `parentUuid` field forms a tree. The importer uses this to:

1. Group assistant messages by `requestId` into LLM turns
2. Match `tool_use` blocks to their `tool_result` blocks via `tool_use_id`
3. Nest tool spans under their LLM turn span
4. Link LLM turns sequentially within a session
5. Detect Agent subagent boundaries

### Detection

A file is a Claude transcript if:
- It's valid JSONL (first line parses as JSON)
- First object has both `sessionId` (string) and `type` (one of `"user"`, `"assistant"`, `"system"`)

## Implementation

### Files

| File | Purpose |
|---|---|
| `src/importers/claude-transcript.ts` | Importer function |
| `src/importers/claude-transcript.test.ts` | Unit tests |
| `src/importers/detect.ts` | Add detection case |
| `src/importers/types.ts` | Add `'claude_transcript'` to ImportFormat |
| `src/importers/import.ts` | Add to dispatcher switch |
| `src/server.ts` | Add `'claude_transcript'` to format enum |

### Importer Function Signature

```typescript
export function importClaudeTranscript(
  content: string,
  name: string,
  options?: ClaudeTranscriptOptions,
): ImportedProfile;

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
```

### Algorithm

1. Parse all JSONL lines into objects
2. Sort by timestamp
3. Group assistant messages by `requestId` → LLM turns
4. For each LLM turn, extract tool_use blocks and find matching tool_results
5. Build frame table: one frame per unique (kind, detail) pair
6. Build spans:
   - Session root span (first to last timestamp)
   - LLM turn spans with token usage as values
   - Tool call spans nested under their LLM turn
   - User input spans between turns (if include_idle)
7. Detect Agent boundaries: tool_use with name `"Agent"` creates a new lane, subsequent tool calls within that Agent's scope go on that lane
8. Return ImportedProfile with all lanes

### Edge Cases

- **Streaming chunks**: Multiple assistant messages share a requestId. Only the last one (with `usage`) carries token counts. Earlier ones carry incremental content.
- **Parallel tool calls**: Multiple tool_use in one assistant message. These get sibling spans under the same LLM turn.
- **Missing tool_result**: Some tool calls may not have results (session ended, tool timed out). These get spans with no end time, flagged in metadata.
- **Multi-day sessions**: Large wall_ms gaps between turns are real (user walked away). The `user_input` spans capture this.
- **Sidechains**: `isSidechain: true` messages are branched conversations. These should be separate lanes or excluded based on options.

## Testing

- Parse minimal 3-message transcript (user → assistant → user)
- Parse transcript with tool_use/tool_result pair, verify wall_ms
- Parse transcript with usage data, verify token dimensions
- Parse transcript with parallel tool calls
- Parse transcript with Agent subagent
- Detection: JSONL with sessionId detected as claude_transcript
- Detection: Regular JSONL not mis-detected
- Round-trip: import → hotspots shows tool names ranked by wall_ms
