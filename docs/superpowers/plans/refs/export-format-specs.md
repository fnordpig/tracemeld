# Export Format Specifications Reference

Distilled reference for implementing `src/exporters/speedscope.ts` and `src/exporters/chrome-trace.ts`, with supplementary notes on pprof and gecko formats for future exporters. All details are grounded in tracemeld's canonical model (`Profile`, `Lane`, `Span`, `Sample`, `Marker`, `Frame`) defined in `src/model/types.ts`.

Parent plan: `docs/superpowers/plans/2026-03-22-roadmap-exports-baselines-messaging.md`

---

## 1. Speedscope File Format

Source: [file-format-spec.ts](https://github.com/jlfwong/speedscope/blob/main/src/lib/file-format-spec.ts) | Schema: `https://www.speedscope.app/file-format-schema.json`

### Top-level structure

```typescript
interface File {
  $schema: 'https://www.speedscope.app/file-format-schema.json'  // required, exact string
  shared: { frames: Frame[] }  // deduplicated frame list, shared across all profiles
  profiles: (EventedProfile | SampledProfile)[]
  name?: string
  activeProfileIndex?: number
  exporter?: string  // e.g. "tracemeld@0.1.1"
}
```

### Frame

```typescript
interface Frame {
  name: string
  file?: string
  line?: number
  col?: number
}
```

### EventedProfile (for spans/traces)

```typescript
interface EventedProfile {
  type: 'evented'
  name: string
  unit: ValueUnit
  startValue: number   // timestamp of first event
  endValue: number     // timestamp of last event
  events: (OpenFrameEvent | CloseFrameEvent)[]
}

// Events reference frames by index into shared.frames
interface OpenFrameEvent  { type: 'O'; at: number; frame: number }
interface CloseFrameEvent { type: 'C'; at: number; frame: number }
```

Events must be ordered by `at` value. Each `O` must have a matching `C`. The `at` values are in whatever unit the profile declares.

### SampledProfile (for samples)

```typescript
interface SampledProfile {
  type: 'sampled'
  name: string
  unit: ValueUnit
  startValue: number
  endValue: number
  samples: number[][]   // each entry is a stack of frame indices (root-to-leaf per speedscope convention)
  weights: number[]     // parallel array, same length as samples
}
```

### ValueUnit

```typescript
type ValueUnit = 'none' | 'nanoseconds' | 'microseconds' | 'milliseconds' | 'seconds' | 'bytes'
```

### Key implementation notes

- The `shared.frames` array is global across all profiles in the file, enabling deduplication.
- Frame indices in events and sample stacks reference into `shared.frames`.
- A single speedscope file can contain multiple profiles (one per lane, or evented + sampled).

---

## 2. Chrome Trace Event Format

Source: [Trace Event Format (Google Doc)](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) | Reference impl: [chrome-trace-event npm](https://github.com/samccone/chrome-trace-event)

### JSON structure

Two valid forms:

```json
// Array format (simpler)
[ { "ph": "X", "ts": 1000, ... }, ... ]

// Object format (preferred for metadata)
{
  "traceEvents": [ ... ],
  "displayTimeUnit": "ms",    // optional, controls UI display only
  "metadata": { ... }         // optional top-level metadata
}
```

**Timestamps are always in microseconds** regardless of `displayTimeUnit`.

### Required fields for all events

| Field  | Type   | Description |
|--------|--------|-------------|
| `ph`   | string | Phase (event type), single character |
| `ts`   | number | Timestamp in **microseconds** |
| `pid`  | number | Process ID |
| `tid`  | number | Thread ID |

### Common optional fields

| Field  | Type   | Description |
|--------|--------|-------------|
| `name` | string | Event name (almost always present) |
| `cat`  | string | Comma-separated category list |
| `args` | object | Arbitrary key-value metadata |
| `dur`  | number | Duration in microseconds (for `X` events) |
| `tdur` | number | Thread clock duration (for `X` events) |

### Event phases relevant to tracemeld export

| Phase | Name | Use for | Notes |
|-------|------|---------|-------|
| `X` | Complete | Spans | Single event with `dur` field. Simplest for export. |
| `B` | Begin | Spans (alternative) | Paired with `E`. Must be ordered by `ts` within a thread. |
| `E` | End | Spans (alternative) | Closes most recent `B` with same `name` on same tid. |
| `i` | Instant | Markers | Point-in-time event. Lowercase `i` is newer; `I` is legacy. Has optional `s` field for scope: `g` (global), `p` (process), `t` (thread). |
| `M` | Metadata | Lane names | Used for `process_name` and `thread_name`. No `ts` needed. |

### Metadata events for naming

```json
{"ph": "M", "pid": 1, "tid": 0, "name": "process_name", "args": {"name": "My Process"}}
{"ph": "M", "pid": 1, "tid": 1, "name": "thread_name", "args": {"name": "Main Thread"}}
```

### Other phases (not needed for initial export, but good to know)

| Phase | Name | Description |
|-------|------|-------------|
| `C` | Counter | Counter values over time |
| `b`/`e`/`n` | Async begin/end/instant | Async events spanning threads (use `id` field) |
| `s`/`t`/`f` | Flow start/step/end | Flow arrows between events |
| `P` | Sample | Stack sample |

---

## 3. pprof Protobuf Format

Source: [profile.proto](https://github.com/google/pprof/blob/main/proto/profile.proto)

### Key messages

```protobuf
message Profile {
  repeated ValueType sample_type = 1;   // describes what each sample value means
  repeated Sample sample = 2;
  repeated Mapping mapping = 3;         // binary address mappings (often empty for LLM profiles)
  repeated Location location = 4;       // code locations
  repeated Function function = 5;       // function metadata
  repeated string string_table = 6;     // ALL strings stored here; index 0 is always ""
  int64 time_nanos = 9;                 // profile collection time (UTC nanoseconds)
  int64 duration_nanos = 10;            // profile duration
  ValueType period_type = 11;           // sampling period type
  int64 period = 12;                    // sampling period value
}

message ValueType {
  int64 type = 1;   // index into string_table (e.g. "cpu", "wall")
  int64 unit = 2;   // index into string_table (e.g. "nanoseconds", "count")
}

message Sample {
  repeated uint64 location_id = 1;   // stack trace, leaf first
  repeated int64 value = 2;          // one per sample_type
  repeated Label label = 3;          // key-value annotations
}

message Location {
  uint64 id = 1;
  uint64 mapping_id = 2;
  uint64 address = 3;
  repeated Line line = 4;            // function + line info (can have multiple for inlining)
  bool is_folded = 5;
}

message Line {
  uint64 function_id = 1;
  int64 line = 2;
  int64 column = 3;
}

message Function {
  uint64 id = 1;
  int64 name = 2;         // index into string_table
  int64 system_name = 3;  // index into string_table
  int64 filename = 4;     // index into string_table
  int64 start_line = 5;
}

message Label {
  int64 key = 1;       // index into string_table
  int64 str = 2;       // string value (index into string_table)
  int64 num = 3;       // numeric value (mutually exclusive with str)
  int64 num_unit = 4;  // index into string_table
}
```

### String table design

All strings are centralized in `string_table`. Every string reference elsewhere in the profile is an `int64` index into this table. Index 0 is always the empty string. This deduplication is critical for keeping protobuf payloads small.

### Key design points for a future exporter

- IDs for Location, Function, Mapping are 1-based (0 means "not set").
- Samples reference Locations by ID (not index); Locations reference Functions by ID.
- For tracemeld, each Frame would map to a Function + Location pair.
- Sample stacks in pprof are **leaf-first** (index 0 = leaf).
- Multi-dimensional values in tracemeld map directly to pprof's `sample_type` + `Sample.value` arrays.

---

## 4. Gecko Profile Format

Source: [gecko-profile-format.md](https://github.com/firefox-devtools/profiler/blob/main/docs-developer/gecko-profile-format.md)

### Top-level structure

```json
{
  "meta": { /* system info, interval, categories, startTime, ... */ },
  "libs": [ /* shared libraries */ ],
  "pages": [ /* page info */ ],
  "threads": [ /* thread objects */ ],
  "processes": [ /* child process profiles (recursive) */ ],
  "pausedRanges": [ /* periods when sampling was paused */ ]
}
```

### Thread structure

Each thread contains columnar tables (arrays of parallel columns, not arrays of objects):

- **`frameTable`**: `{ location: int[], relevantForJS: bool[], innerWindowID: int[], implementation: int[], line: int[], column: int[], category: int[], subcategory: int[] }`
- **`stackTable`**: `{ frame: int[], prefix: (int|null)[] }` — linked-list representation; `prefix` points to parent stack entry
- **`funcTable`**: `{ name: int[], isJS: bool[], resource: int[], address: int[] }`
- **`stringTable`**: `string[]` — all strings referenced by index
- **`samples`**: `{ stack: int[], time: float[], eventDelay: float[] }`
- **`markers`**: `{ name: int[], time: float[], data: object[] }`

### Key design points

- **Columnar storage**: each "table" stores properties as parallel arrays rather than arrays of objects, optimized for GC pressure in web UIs.
- **Stack reconstruction**: follow the `prefix` chain in `stackTable` from a sample's `stack` index back to `null` (the root).
- **Three-level indirection**: `sample.stack` -> `stackTable.frame` -> `frameTable.func` -> `funcTable.name` -> `stringArray[name]`.
- **Categories**: defined in `meta.categories`, referenced by index from `frameTable.category`.
- **Timestamps**: in milliseconds since `meta.startTime`.
- **Key challenge for a future Gecko exporter**: tracemeld stores flat stack arrays per sample, but Gecko requires reconstructing the `stackTable` prefix-chain (trie) representation. This means building a shared prefix trie from all observed stacks.

---

## 5. Format Comparison Matrix

| Feature | Speedscope | Chrome Trace | pprof | Gecko |
|---------|-----------|-------------|-------|-------|
| Encoding | JSON | JSON | Protobuf (gzipped) | JSON |
| Spans/durations | EventedProfile (O/C events) | X, B/E events | No (samples only) | No (samples only) |
| Samples/stacks | SampledProfile | No native support | Yes (core purpose) | Yes (core purpose) |
| Instant markers | No | `i` events | No | markers structure |
| Multi-dimensional values | Multiple profiles | args bag | Multiple sample_types | weight array (single) |
| Timestamp unit | Configurable (unit field) | Microseconds (fixed) | Nanoseconds (fixed) | Milliseconds (meta.interval) |
| Thread/process model | Multiple profiles | pid/tid fields | Single profile | threads array |
| String deduplication | shared.frames | None | string_table (index 0 = "") | stringArray per thread |
| Schema validation | `$schema` URL | None | `.proto` definition | Version field |

---

## 6. Mapping Guidance: tracemeld to export formats

### tracemeld `Frame` to format frames

| tracemeld `Frame` field | Speedscope `Frame` | Chrome Trace | pprof | Gecko |
|---|---|---|---|---|
| `name` | `name` | event `name` | `Function.name` (via string_table) | `funcTable.name` (via stringTable) |
| `file` | `file` | `args.file` (convention) | `Function.filename` (via string_table) | n/a or resource |
| `line` | `line` | `args.line` (convention) | `Line.line` | `frameTable.line` |
| `col` | `col` | n/a | `Line.column` | `frameTable.column` |
| `category_index` | n/a | `cat` field | n/a | `frameTable.category` |

### tracemeld `Span` to format events

**Speedscope (EventedProfile)**:
- Each span emits an `O` event at `start_time` and a `C` event at `end_time`.
- `frame` field references the span's `frame_index` (indices align since both use deduplicated frame arrays).
- Unit should be `'milliseconds'` (tracemeld stores wall time in ms).
- `startValue` / `endValue` = min/max timestamps across all spans in the lane.

**Chrome Trace**:
- Preferred: emit `X` (complete) events. `ts` = `start_time * 1000` (convert ms to us), `dur` = `(end_time - start_time) * 1000`.
- Alternative: emit `B`/`E` pairs.
- `pid` and `tid` from `Lane.pid` / `Lane.tid` (assign synthetic IDs if absent).
- `name` = `profile.frames[span.frame_index].name`.
- `args` = `span.args` (pass through directly).
- If `span.error` is set, include it in `args`.

### tracemeld `Sample` to format samples

**Speedscope (SampledProfile)**:
- `samples[i]` = `sample.stack` (array of frame indices; verify root-first ordering).
- `weights[i]` = `sample.values[dimIdx]` for the chosen dimension.
- Create one SampledProfile per lane that has samples.

**pprof**:
- Each `Sample` maps to a pprof `Sample` with `location_id` list derived from the stack.
- Each unique frame index maps to a `Location` + `Function`.
- `sample.values` maps directly to pprof `Sample.value` (aligned to `sample_type`).
- `sample.labels` map to pprof `Label` entries.

### tracemeld `Marker` to format events

**Chrome Trace**: emit `i` (instant) events. `ts` = `marker.timestamp * 1000`, `name` = `marker.name`, `args` = `marker.data`, `s` = `"t"` (thread scope). If `marker.end_time` is set, could emit `X` event instead.

**Speedscope**: no direct marker support. Options: (a) omit markers, (b) emit zero-duration O/C pairs as visual indicators.

### tracemeld `Lane` to format threads/profiles

**Speedscope**: each lane becomes a separate profile entry in `profiles[]`. A lane with spans produces an `EventedProfile`; a lane with samples produces a `SampledProfile`. A lane with both could produce two profile entries.

**Chrome Trace**: each lane becomes a distinct `pid:tid` pair. Emit `M` (metadata) events for `thread_name` (from `lane.name`) and optionally `process_name`. Use `lane.pid` / `lane.tid` if set; otherwise assign synthetic IDs (e.g., pid=1, tid=lane index).

### tracemeld `ValueType` / unit mapping

| tracemeld unit | Speedscope unit | Chrome Trace | pprof string_table |
|---|---|---|---|
| `milliseconds` | `'milliseconds'` | multiply by 1000 for us timestamps | `"milliseconds"` |
| `microseconds` | `'microseconds'` | use directly | `"microseconds"` |
| `nanoseconds` | `'nanoseconds'` | divide by 1000 for us timestamps | `"nanoseconds"` |
| `seconds` | `'seconds'` | multiply by 1e6 for us timestamps | `"seconds"` |
| `bytes` | `'bytes'` | n/a (use args) | `"bytes"` |
| `none` | `'none'` | n/a (use args) | `"count"` |

### Timestamp conversion summary

tracemeld stores times in **milliseconds**. Conversion:
- **Speedscope**: use directly (set `unit: 'milliseconds'`)
- **Chrome Trace**: multiply by 1000 (Chrome expects **microseconds**)
- **pprof**: multiply by 1e6 (pprof expects **nanoseconds**)
- **Gecko**: use directly (Gecko uses **milliseconds**)

---

## 7. Implementation Patterns

The existing `src/exporters/collapsed.ts` establishes the exporter pattern:
- Pure function: `(profile: Profile, options?) => output`
- Iterate `profile.lanes`, then lane's spans/samples
- Reference frames via `profile.frames[index]`
- Select value dimension by index or key name

The existing `src/importers/chrome-trace.ts` provides the inverse mapping for Chrome Trace, useful for verifying round-trip correctness.

---

## 8. Sources

- Speedscope file format spec: https://github.com/jlfwong/speedscope/blob/main/src/lib/file-format-spec.ts
- Speedscope JSON schema: https://www.speedscope.app/file-format-schema.json
- Chrome Trace Event Format: https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview
- chrome-trace-event npm: https://github.com/samccone/chrome-trace-event
- Catapult trace event format docs: https://chromium.googlesource.com/catapult/+/HEAD/docs/trace-event-format.md
- pprof profile.proto: https://github.com/google/pprof/blob/main/proto/profile.proto
- Gecko profile format: https://github.com/firefox-devtools/profiler/blob/main/docs-developer/gecko-profile-format.md
- tracemeld canonical model: `src/model/types.ts`
- tracemeld collapsed exporter: `src/exporters/collapsed.ts`
- tracemeld chrome-trace importer: `src/importers/chrome-trace.ts`
