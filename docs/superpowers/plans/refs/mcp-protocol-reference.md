# MCP Protocol Reference for Tracemeld

## 1. Tool Annotations

The `ToolAnnotations` type is part of a tool's definition, alongside `name`, `description`, and `inputSchema`. Annotations are hints (not guarantees) that clients use for UX decisions like auto-approving safe tools.

### Fields (all boolean, all default to false)

- **`readOnlyHint`**: Tool does not modify any state. Clients like Claude Code may auto-approve read-only tools without user confirmation.
- **`destructiveHint`**: Tool may perform destructive/irreversible operations (delete data, overwrite files). When false and readOnlyHint is also false, the tool modifies state but non-destructively.
- **`idempotentHint`**: Calling repeatedly with the same arguments has no additional effect beyond the first call.
- **`openWorldHint`**: Tool interacts with external systems beyond the MCP server (filesystem, network, APIs). When false, tool operates only on internal server state.

### Tracemeld Tool Annotation Assignments

**Analysis tools** (profile_summary, hotspots, hotpaths, bottleneck, spinpaths, starvations, focus_function, find_waste, explain_span, list_baselines, diff_profile):
```json
{ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
```

**Instrumentation tools** (trace, mark):
```json
{ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
```

**Import tool** (import_profile):
```json
{ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
```

**Export/baseline tools** (export_profile, save_baseline):
```json
{ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
```

Spec reference: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## 2. Sampling Protocol (sampling/createMessage)

Server-initiated LLM reasoning. The server sends a request to the client asking the client's LLM to reason about provided data.

### Request Schema
```typescript
interface CreateMessageRequest {
  messages: SamplingMessage[];
  systemPrompt?: string;
  modelPreferences?: {
    costPriority?: number;         // 0-1, higher = prefer cheaper
    speedPriority?: number;        // 0-1, higher = prefer faster
    intelligencePriority?: number; // 0-1, higher = prefer smarter
    hints?: { name?: string }[];   // model name hints
  };
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  includeContext?: "none" | "thisServer" | "allServers";
  metadata?: Record<string, unknown>;
}
```

### Response
```typescript
interface CreateMessageResult {
  model: string;
  role: "assistant";
  content: TextContent | ImageContent;
  stopReason?: string;
}
```

### Graceful Degradation Pattern for Tracemeld
```typescript
export async function askLLM(
  server: McpServer,
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<string | null> {
  try {
    const result = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
      systemPrompt,
      maxTokens: options?.maxTokens ?? 1024,
    });
    return result.content.type === 'text' ? result.content.text : null;
  } catch {
    return null; // Client doesn't support sampling — use template fallback
  }
}
```

### First Use-Case: Bottleneck Recommendations
The `bottleneck` tool currently uses a switch statement on frame kind for generic advice. With sampling, it can ask the LLM for specific, context-aware recommendations. Falls back to templates if sampling unavailable.

Spec reference: https://modelcontextprotocol.io/specification/draft/client/sampling

## 3. Elicitation Protocol (elicitation/create)

Server-initiated interactive forms. The server requests structured input from the user via a JSON Schema-defined form.

### Request Structure
- `message`: Human-readable explanation of what's needed
- `requestedSchema`: JSON Schema defining form fields (string, number, boolean, enum)

### Response
- `action`: "accept" | "decline" | "cancel"
- `content`: Record matching the schema (when accepted)

Less critical for tracemeld's immediate roadmap, but useful for future interactive workflows (e.g., asking the user which baseline to compare against).

Spec reference: https://modelcontextprotocol.io/specification/draft/client/elicitation

## 4. SEP-1577: Sampling With Tools

GitHub: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577

**Status**: Approved and merged (November 2025).

**Core Addition**: Adds `tools` and `toolChoice` parameters to `sampling/createMessage`, enabling MCP servers to conduct agentic loops using client LLM tokens while maintaining user supervision.

**New Schema Fields**:
- `tools?: Tool[]` — available tools with JSON schemas
- `toolChoice?: { mode?: "auto" | "required" | "none" }` — controls tool invocation

**Impact for Tracemeld**: Enables future workflows where the bottleneck tool's sampling request could let the LLM call back into tracemeld's analysis tools (e.g., sampling asks "what's the root cause?" and the LLM calls explain_span to investigate). Implement basic sampling first; add tool-augmented sampling when client support matures.

## 5. Task System (Async Long-Running Operations)

For operations that take significant time (large trace imports, complex analysis).

### Lifecycle
`pending → running → completed | failed | cancelled`

### Key Operations
- `tasks/create` — initiate a long-running operation
- `tasks/get` — check status and retrieve results
- `tasks/cancel` — abort a running task

### Progress Notifications
Server sends progress updates via notifications during task execution.

Potentially useful for tracemeld's import of large trace files (multi-GB Chrome traces, pprof dumps).

Reference: https://deepwiki.com/modelcontextprotocol/modelcontextprotocol/2.7-task-system-and-async-operations

## 6. Server Capability Declaration

Tracemeld should declare sampling capability in its McpServer constructor:

```typescript
const server = new McpServer({
  name: 'tracemeld',
  version: pkg.version,
}, {
  capabilities: {
    sampling: {},
  },
});
```

## 7. Additional References

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification changelog: https://modelcontextprotocol.io/specification/changelog
- streamableHttp transport: https://modelcontextprotocol.io/specification/draft/basic/transports#streamable-http
- Parent planning doc: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`
