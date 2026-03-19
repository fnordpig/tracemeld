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

Tracemeld is a stateless MCP server for LLM performance profiling.

### Source Layout
- `src/model/` — Canonical data model (`Profile`, `Frame`, `Span`, `Sample`, `Marker`), `ProfileBuilder`, `FrameTable`, `ProfilerState`
- `src/instrument/` — `trace` (begin/end spans) and `mark` (instant markers) tool handlers
- `src/analysis/` — Analysis tools (profile_summary, hotspots, explain_span, etc.)
- `src/importers/` — Format importers (pprof, collapsed, chrome-trace, gecko, speedscope)
- `src/exporters/` — Format exporters
- `src/patterns/` — Anti-pattern detection heuristics
- `src/server.ts` — MCP server setup and tool registration

### Conventions
- All tool handlers are pure functions: `(state: ProfilerState, input: T) => Result`
- Tests mirror source: `src/model/foo.test.ts` tests `src/model/foo.ts`
- Frame names use `{kind}:{detail}` convention (e.g. `bash:npm test`, `file_read:src/auth.ts`)
- Spans reference frames by index into a deduplicated `FrameTable`
- Multi-dimensional values are aligned to `Profile.value_types[]`

### Design Spec
Full specification: `design.md`
