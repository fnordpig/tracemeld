# CLAUDE.md

## Development Commands

```bash
npm run build          # TypeScript compilation
npm run dev            # Watch mode
npm run test           # Run tests
npm run test:watch     # Watch mode tests
npm run lint           # ESLint with strict-type-checked
npm run inspect        # Build + open MCP Inspector in browser
```

## Architecture

Tracemeld is a stateless MCP server for performance profiling.

### Source Layout
- `src/model/` — Canonical data model (`Profile`, `Frame`, `Span`, `Sample`, `Marker`), `ProfileBuilder`, `FrameTable`, `ProfilerState`
- `src/instrument/` — `trace` (begin/end spans) and `mark` (instant markers) tool handlers
- `src/analysis/` — Analysis tools: profile_summary, hotspots, hotpaths, bottleneck, explain_span, focus_function, spinpaths, starvations, diff, query, waste
- `src/importers/` — Format importers: pprof, collapsed, chrome-trace, gecko, v8-cpuprofile, nsight-sqlite, xctrace, claude-transcript
- `src/exporters/` — Format exporters: collapsed, speedscope, chrome-trace, baseline
- `src/patterns/` — Anti-pattern detectors: blind-edit, redundant-read, retry-loop, agent-sprawl, interrupted-tool, context-bloat
- `src/messaging/` — Sampling and messaging helpers
- `src/server.ts` — MCP server setup and tool registration (20 tools)

### Conventions
- All tool handlers are pure functions: `(state: ProfilerState, input: T) => Result`
- Tests mirror source: `src/model/foo.test.ts` tests `src/model/foo.ts`
- Frame names use `{kind}:{detail}` convention (e.g. `bash:npm test`, `file_read:src/auth.ts`)
- Spans reference frames by index into a deduplicated `FrameTable`
- Multi-dimensional values are aligned to `Profile.value_types[]`
- Tool input schemas use `z.coerce.number()` so agents can pass strings or numbers
