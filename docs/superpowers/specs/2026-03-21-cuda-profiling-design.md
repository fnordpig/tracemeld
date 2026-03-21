# CUDA Profiling Support — Design Spec

## Overview

Add CUDA GPU profiling to tracemeld via an Nsight Systems SQLite importer and a cuda-profiling skill. No GPU-specific anti-pattern detectors in v1 — the existing analysis tools (hotspots, starvations, explain_span, focus_function) already cover core GPU analysis use cases.

## Motivation

Support profiling CUDA GPU workloads (Rust, C++, Python) by importing Nsight Systems traces into tracemeld's canonical model. The same analysis tools that work on LLM agent profiles and CPU profiles work on GPU data without modification.

## Components

### 1. Nsight SQLite Importer (`src/importers/nsight-sqlite.ts`)

#### What it reads

NVIDIA Nsight Systems exports `.nsys-rep` → SQLite via `nsys export --type sqlite`. Relevant tables:

| Table | Content |
|-------|---------|
| `StringIds` | Global string deduplication (`id → value`) |
| `CUPTI_ACTIVITY_KIND_KERNEL` | GPU kernel executions (start/end ns, device, stream, grid/block dims, shared mem, registers) |
| `CUPTI_ACTIVITY_KIND_MEMCPY` | Memory transfers (start/end ns, bytes, copy kind: H2D/D2H/D2D/etc) |
| `CUPTI_ACTIVITY_KIND_MEMSET` | Memset operations (start/end ns, bytes) |
| `CUPTI_ACTIVITY_KIND_RUNTIME` | CPU-side CUDA Runtime API calls (start/end ns, correlationId) |
| `CUPTI_ACTIVITY_KIND_SYNCHRONIZATION` | Sync events (cudaDeviceSynchronize, etc) |
| `NVTX_EVENTS` | User annotations (push/pop ranges, marks) |
| `CUBLAS_EVENTS` | cuBLAS API calls |
| `CUDNN_EVENTS` | cuDNN API calls |

Tables are optional — importer skips any that don't exist.

#### Lanes (device-level)

| Lane ID | Source | Kind |
|---------|--------|------|
| `cuda-runtime` | `CUPTI_ACTIVITY_KIND_RUNTIME` | `custom` |
| `gpu-{deviceId}-kernels` | `CUPTI_ACTIVITY_KIND_KERNEL` | `worker` |
| `gpu-{deviceId}-memory` | `MEMCPY` + `MEMSET` | `worker` |
| `nvtx` | `NVTX_EVENTS` (ranges only) | `custom` |
| `cublas` | `CUBLAS_EVENTS` | `custom` |
| `cudnn` | `CUDNN_EVENTS` | `custom` |

Lanes only created if the corresponding table exists and has rows. No stream-level lane splitting — stream ID is stored in `span.args.streamId` for analysis tools to group by.

#### Frames

Follow `{kind}:{detail}` convention:

| Source | Frame name | Example |
|--------|-----------|---------|
| Kernel | `kernel:{demangledName}` | `kernel:matmul_f32` |
| Memcpy | `memcpy:{copyKindLabel}` | `memcpy:HtoD` |
| Memset | `memset` | `memset` |
| Runtime API | `cuda_api:{name}` | `cuda_api:cudaLaunchKernel` |
| Sync | `cuda_sync:{syncType}` | `cuda_sync:cudaDeviceSynchronize` |
| NVTX range | `nvtx:{text}` | `nvtx:forward_pass` |
| NVTX mark | `nvtx_mark:{text}` | `nvtx_mark:epoch_start` |
| cuBLAS | `cublas:{name}` | `cublas:cublasSgemm` |
| cuDNN | `cudnn:{name}` | `cudnn:cudnnConvolutionForward` |

Names resolved via `StringIds` table. Deduplicated through `FrameTable`.

#### Value types

Added via `ProfileBuilder.addValueType()`:

| Key | Unit | Description | Applies to |
|-----|------|-------------|-----------|
| `wall_ms` | milliseconds | Wall-clock duration (matches existing convention) | All spans |
| `bytes` | bytes | Bytes transferred | memcpy, memset |
| `threads` | none | Total thread count (grid * block) | Kernels |
| `shared_mem_bytes` | bytes | Shared memory per block (static + dynamic) | Kernels |
| `registers` | none | Registers per thread | Kernels |

Uses `wall_ms` (not `wall_ns`) to match the existing convention across all other importers. Nanosecond precision is preserved in `span.args.start_ns`/`end_ns` for anyone who needs it. Duration conversion: `(end_ns - start_ns) / 1_000_000`.

Missing values default to 0.

#### Correlation ID linkage

`CUPTI_ACTIVITY_KIND_RUNTIME` rows have `correlationId` matching kernel/memcpy rows:

1. Build `Map<number, string>` from `correlationId → runtime_api_span_id`
2. For each kernel/memcpy span, set `parent_id` to the matching runtime API span
3. Push the kernel/memcpy span's `id` string into the runtime span's `children[]` array (which stores child span IDs, not span objects)

Creates two-level trees: `cuda_api:cudaLaunchKernel → kernel:matmul_f32`.

#### NVTX handling

- `eventType = 59` (push/pop): pair into spans using per-thread stack keyed by `globalTid`
- `eventType = 60` (start/end): match by `rangeId`
- `eventType = 34` (mark): create `Marker` entries, not spans

No cross-table NVTX→kernel nesting in v1 (timestamp containment is fragile).

#### Span args

Kernel spans store GPU metadata in `args`:

```typescript
args: {
  deviceId: number,
  streamId: number,
  contextId: number,
  gridDim: [number, number, number],
  blockDim: [number, number, number],
  correlationId: number,
  start_ns: number,  // raw nanosecond timestamp
  end_ns: number,
}
```

Memcpy spans store `{ deviceId, streamId, copyKind, bytes, start_ns, end_ns }`.

#### Timestamp normalization

Nsight timestamps are nanoseconds. Canonical model uses milliseconds for `start_time`/`end_time`. Raw nanosecond values preserved in `span.args.start_ns`/`end_ns`.

#### Import options

```typescript
interface NsightImportOptions {
  max_kernels?: number;  // Cap kernel span count (default: unlimited)
  time_range?: { start_ns: number; end_ns: number };  // Filter to time window
}
```

When `max_kernels` is hit, a warning marker is added noting how many events were truncated.

### 2. SQLite dependency: sql.js

Use `sql.js` (SQLite compiled to WASM). Zero native dependencies, works everywhere.

```json
{
  "dependencies": {
    "sql.js": "^1"
  }
}
```

**WASM loading:** `sql.js` can inline WASM as base64 when using the `sql-wasm.js` bundle (default for Node.js `require`/`import`). No special `locateFile` config needed. Verify this works with the tracemeld build pipeline during implementation; if the WASM file needs explicit bundling, add the `.wasm` asset to `package.json` `files` array.

### 3. Async/binary import pathway

**Problem:** The existing import pipeline is synchronous and string-based. `sql.js` requires async initialization (`await initSqlJs()`), and SQLite is binary.

**Solution:** Handle nsight-sqlite as a special case in the `server.ts` tool handler, **before** the string decode step. The existing `importProfile()` function and all other importers remain synchronous and unchanged.

Flow in `server.ts` tool handler:
```
1. Read file as raw Buffer (already happens at line 160)
2. Check SQLite magic bytes (first 16 bytes = "SQLite format 3\0")
   OR format hint is 'nsight-sqlite'
3. If nsight-sqlite:
   a. Call `await importNsightSqlite(rawBuffer, name, options)` → ImportedProfile
   b. Merge into state.builder via existing mergeImportedProfile()
   c. Return ImportProfileResult
4. Else: proceed with existing string decode → importProfile() path
```

This means:
- `importNsightSqlite()` is **async** (the only async importer) and returns `ImportedProfile`
- `mergeImportedProfile()` is extracted from `import.ts` as a named export so `server.ts` can call it directly
- `importProfile()` signature stays synchronous — no changes to existing importers
- The tool handler in `server.ts` becomes async (MCP handlers can be async)
- `detectFormat()` in `detect.ts` is **not changed** — SQLite detection happens in `server.ts` at the byte level before any string conversion

### 4. Format detection

SQLite detection happens in `server.ts` tool handler (not in `detect.ts`):

```typescript
function isSqliteBuffer(buf: Buffer): boolean {
  return buf.length >= 16 && buf.subarray(0, 15).toString('ascii') === 'SQLite format 3';
}
```

This is checked before the existing string decode logic. `detect.ts` is unchanged.

`'nsight-sqlite'` is still added to `ImportFormat` in `types.ts` for the format enum/hint, but auto-detection is byte-level in the tool handler.

### 5. MCP tool changes

**`import_profile`** in `src/server.ts`:

- Add `'nsight-sqlite'` to format enum
- Add optional `nsight_options` parameter:
  ```
  nsight_options: { max_kernels?: number, time_range?: { start_ns, end_ns } }
  ```
- Tool handler becomes async
- SQLite detection + nsight import path added before string decode
- `mergeImportedProfile` imported from `import.ts`

### 6. Skill: `cuda-profiling`

Plugin skill alongside existing `profile-rust`, `profile-python`, etc.

Content:
1. Prerequisites (CUDA toolkit, `nsys --version`)
2. Capture: `nsys profile --trace=cuda,nvtx -o profile ./program`
3. NVTX annotations for Rust (`nvtx` crate), Python (torch.cuda.nvtx), C++ (nvToolsExt.h)
4. Export: `nsys export --type sqlite profile.nsys-rep`
5. Import: `import_profile({ source: "profile.sqlite", format: "nsight-sqlite" })`
6. Analysis workflow using existing tools
7. Common GPU optimization patterns

## What existing analysis tools provide on GPU data

- **hotspots** — ranks kernels by `wall_ms`, shows grid/block dims in args
- **starvations** — detects GPU lanes idle while CPU is busy (GPU starvation)
- **explain_span** — shows kernel→API linkage via parent_id, neighboring spans
- **focus_function** — aggregates all invocations of a kernel across the trace
- **profile_summary** — groups by kind (kernel, memcpy, cuda_api, etc.)
- **find_waste** — runs registered patterns (GPU patterns added in future)

## What's NOT in v1

- GPU-specific anti-pattern detectors (add when real traces inform thresholds)
- Stream-level lane splitting (data in `span.args.streamId`, lanes stay device-level)
- NVTX→kernel nesting by timestamp containment
- `profile_summary` `group_by: "device"` enhancement
- Nsight Compute import (per-kernel occupancy/throughput metrics)
- Chrome trace / Perfetto export of GPU lanes

## Test strategy

Synthetic SQLite fixtures built programmatically in tests:
- Create tables with `sql.js`, insert representative rows, export as `Uint8Array`
- Test cases:
  - Basic kernel import (1 kernel, 1 memcpy → correct frame names, ms timestamps)
  - String resolution (kernel names resolved from `StringIds`, not raw IDs)
  - Correlation linkage (runtime API span is parent of kernel span)
  - NVTX ranges (push/pop paired into spans with correct text)
  - NVTX marks (become `Marker` entries, not spans)
  - Missing tables (import succeeds with only `StringIds` + `NVTX_EVENTS`)
  - `max_kernels` cap (10k kernel rows, cap at 100 → exactly 100 spans + warning marker)
  - **Merge into existing builder** (import nsight data into a builder with LLM spans — GPU value types added correctly, LLM dimensions get 0s on GPU spans)
- No dependency on NVIDIA hardware or `nsys`

## Files changed/added

| File | Change |
|------|--------|
| `src/importers/nsight-sqlite.ts` | **New** — async importer, returns `ImportedProfile` |
| `src/importers/nsight-sqlite.test.ts` | **New** — tests with synthetic SQLite fixtures |
| `src/importers/types.ts` | Add `'nsight-sqlite'` to `ImportFormat` |
| `src/importers/import.ts` | Export `mergeImportedProfile` as named export |
| `src/server.ts` | Async tool handler, SQLite detection before string decode, nsight import path, format enum, `nsight_options` param |
| `package.json` | Add `sql.js` + `@types/sql.js` dependencies |
| Skill file | **New** — cuda-profiling skill (alongside profile-rust, profile-python, etc.) |
