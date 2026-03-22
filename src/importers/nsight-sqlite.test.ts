// src/importers/nsight-sqlite.test.ts
import { describe, it, expect } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { importNsightSqlite } from './nsight-sqlite.js';
import type { Lane } from '../model/types.js';
import { ProfileBuilder } from '../model/profile.js';
import { mergeImportedProfile } from './import.js';

describe('sql.js WASM loading', () => {
  it('initializes sql.js and creates an in-memory database', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE test (id INTEGER, name TEXT)');
    db.run("INSERT INTO test VALUES (1, 'hello')");
    const result = db.exec('SELECT * FROM test');
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual([[1, 'hello']]);
    db.close();
  });
});

describe('importNsightSqlite', () => {
  async function createTestDb(setup: (db: Database) => void): Promise<Uint8Array> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT)');
    setup(db);
    const data = db.export();
    db.close();
    return data;
  }

  function findLane(lanes: Lane[], id: string): Lane {
    const lane = lanes.find((l) => l.id === id);
    expect(lane).toBeDefined();
    return lane as Lane;
  }

  it('resolves kernel names from StringIds', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'matmul_f32')");
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
        demangledName INTEGER, start INTEGER, end INTEGER,
        deviceId INTEGER, streamId INTEGER, contextId INTEGER,
        correlationId INTEGER,
        gridX INTEGER, gridY INTEGER, gridZ INTEGER,
        blockX INTEGER, blockY INTEGER, blockZ INTEGER,
        staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
        registersPerThread INTEGER
      )`);
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (
        1, 1000000, 2000000,
        0, 1, 1, 100,
        128, 1, 1, 256, 1, 1,
        4096, 0, 32
      )`);
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    expect(result.format).toBe('nsight_sqlite');

    const kernelLane = findLane(result.profile.lanes, 'gpu-0-kernels');
    expect(kernelLane.spans).toHaveLength(1);

    const span = kernelLane.spans[0];
    const frame = result.profile.frames[span.frame_index];
    expect(frame.name).toBe('kernel:matmul_f32');

    // Check values: wall_ms, bytes, threads, shared_mem, registers
    expect(span.values[0]).toBeCloseTo(1); // 1ms = 1_000_000ns
    expect(span.values[2]).toBe(128 * 256); // threads = gridX * blockX
    expect(span.values[3]).toBe(4096); // shared mem
    expect(span.values[4]).toBe(32); // registers
  });

  it('imports memcpy with bytes and copy kind', async () => {
    const data = await createTestDb((db) => {
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (
        copyKind INTEGER, start INTEGER, end INTEGER,
        deviceId INTEGER, streamId INTEGER, correlationId INTEGER, bytes INTEGER
      )`);
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (
        1, 5000000, 6000000, 0, 1, 200, 1048576
      )`);
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const memLane = findLane(result.profile.lanes, 'gpu-0-memory');
    expect(memLane.spans).toHaveLength(1);

    const span = memLane.spans[0];
    const frame = result.profile.frames[span.frame_index];
    expect(frame.name).toBe('memcpy:HtoD');
    expect(span.values[1]).toBe(1048576); // bytes
    expect(span.values[0]).toBeCloseTo(1); // 1ms
  });

  it('links kernel to runtime API span via correlationId', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'cudaLaunchKernel')");
      db.run("INSERT INTO StringIds VALUES (2, 'my_kernel')");

      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (
        nameId INTEGER, start INTEGER, end INTEGER, correlationId INTEGER
      )`);
      db.run('INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME VALUES (1, 1000000, 3000000, 42)');

      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
        demangledName INTEGER, start INTEGER, end INTEGER,
        deviceId INTEGER, streamId INTEGER, contextId INTEGER,
        correlationId INTEGER,
        gridX INTEGER, gridY INTEGER, gridZ INTEGER,
        blockX INTEGER, blockY INTEGER, blockZ INTEGER,
        staticSharedMemory INTEGER, dynamicSharedMemory INTEGER,
        registersPerThread INTEGER
      )`);
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (
        2, 1500000, 2500000, 0, 1, 1, 42,
        64, 1, 1, 128, 1, 1, 2048, 0, 16
      )`);
    });

    const result = await importNsightSqlite(data, 'test.sqlite');

    const runtimeLane = findLane(result.profile.lanes, 'cuda-runtime');
    const runtimeSpan = runtimeLane.spans[0];
    expect(result.profile.frames[runtimeSpan.frame_index].name).toBe(
      'cuda_api:cudaLaunchKernel',
    );

    const kernelLane = findLane(result.profile.lanes, 'gpu-0-kernels');
    const kernelSpan = kernelLane.spans[0];

    // Kernel's parent_id should reference the runtime span
    expect(kernelSpan.parent_id).toBe(runtimeSpan.id);
    // Runtime span's children should include the kernel span
    expect(runtimeSpan.children).toContain(kernelSpan.id);
  });

  it('imports synchronization events', async () => {
    const data = await createTestDb((db) => {
      db.run(`CREATE TABLE ENUM_CUPTI_SYNC_TYPE (
        id INTEGER, name TEXT, label TEXT
      )`);
      db.run("INSERT INTO ENUM_CUPTI_SYNC_TYPE VALUES (4, 'CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_CONTEXT_SYNCHRONIZE', 'Context sync')");
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_SYNCHRONIZATION (
        syncType INTEGER, start INTEGER, end INTEGER, correlationId INTEGER
      )`);
      db.run('INSERT INTO CUPTI_ACTIVITY_KIND_SYNCHRONIZATION VALUES (4, 10000000, 15000000, 300)');
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const runtimeLane = findLane(result.profile.lanes, 'cuda-runtime');

    const syncSpan = runtimeLane.spans[0];
    const frame = result.profile.frames[syncSpan.frame_index];
    expect(frame.name).toBe('cuda_sync:Context sync');
    expect(syncSpan.values[0]).toBeCloseTo(5); // 5ms
  });

  it('pairs NVTX push/pop into spans', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'forward_pass')");
      db.run(`CREATE TABLE NVTX_EVENTS (
        textId INTEGER, text TEXT, start INTEGER, end INTEGER, eventType INTEGER
      )`);
      // eventType 59 = range start/push (stored as complete range with start+end)
      db.run('INSERT INTO NVTX_EVENTS VALUES (1, NULL, 1000000, 5000000, 59)');
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const nvtxLane = findLane(result.profile.lanes, 'nvtx');
    expect(nvtxLane.spans).toHaveLength(1);

    const span = nvtxLane.spans[0];
    const frame = result.profile.frames[span.frame_index];
    expect(frame.name).toBe('nvtx:forward_pass');
    expect(span.values[0]).toBeCloseTo(4); // 4ms
  });

  it('converts NVTX marks to Markers', async () => {
    const data = await createTestDb((db) => {
      db.run(`CREATE TABLE NVTX_EVENTS (
        textId INTEGER, text TEXT, start INTEGER, end INTEGER, eventType INTEGER
      )`);
      // eventType 34 = instant mark
      db.run("INSERT INTO NVTX_EVENTS VALUES (NULL, 'epoch_start', 2000000, NULL, 34)");
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const nvtxLane = findLane(result.profile.lanes, 'nvtx');
    expect(nvtxLane.markers).toHaveLength(1);
    expect(nvtxLane.markers[0].name).toBe('nvtx_mark:epoch_start');
    expect(nvtxLane.markers[0].timestamp).toBeCloseTo(2); // 2ms
  });

  it('imports cuBLAS events', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'cublasSgemm')");
      db.run(`CREATE TABLE CUBLAS_EVENTS (
        nameId INTEGER, start INTEGER, end INTEGER
      )`);
      db.run('INSERT INTO CUBLAS_EVENTS VALUES (1, 3000000, 4000000)');
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const cublasLane = findLane(result.profile.lanes, 'cublas');
    expect(cublasLane.spans).toHaveLength(1);

    const span = cublasLane.spans[0];
    const frame = result.profile.frames[span.frame_index];
    expect(frame.name).toBe('cublas:cublasSgemm');
    expect(span.values[0]).toBeCloseTo(1); // 1ms
  });

  it('succeeds with only StringIds and NVTX_EVENTS', async () => {
    const data = await createTestDb((db) => {
      db.run(`CREATE TABLE NVTX_EVENTS (
        start INTEGER, end INTEGER, globalTid INTEGER,
        textId INTEGER, text TEXT,
        eventType INTEGER, rangeId INTEGER,
        domainId INTEGER, category INTEGER, color INTEGER
      )`);
      db.run("INSERT INTO NVTX_EVENTS VALUES (1000000, 2000000, 1, NULL, 'test_range', 59, 0, 0, 0, 0)");
    });

    const result = await importNsightSqlite(data, 'test');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].id).toBe('nvtx');
  });

  it('caps kernel import at max_kernels and adds warning marker', async () => {
    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'kernel_fn')");
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
        demangledName INTEGER, start INTEGER, end INTEGER,
        deviceId INTEGER, streamId INTEGER, contextId INTEGER, correlationId INTEGER,
        gridX INTEGER, gridY INTEGER, gridZ INTEGER,
        blockX INTEGER, blockY INTEGER, blockZ INTEGER,
        staticSharedMemory INTEGER, dynamicSharedMemory INTEGER, registersPerThread INTEGER
      )`);
      for (let i = 0; i < 50; i++) {
        db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (1, ${i * 1000000}, ${(i + 1) * 1000000}, 0, 1, 0, ${i}, 1, 1, 1, 1, 1, 1, 0, 0, 32)`);
      }
    });

    const result = await importNsightSqlite(data, 'test', { max_kernels: 10 });
    const kernelLane = result.profile.lanes.find(l => l.id === 'gpu-0-kernels');
    if (!kernelLane) throw new Error('kernelLane not found');
    expect(kernelLane.spans).toHaveLength(10);
    expect(kernelLane.markers).toHaveLength(1);
    expect(kernelLane.markers[0].severity).toBe('warning');
    expect(kernelLane.markers[0].name).toContain('Truncated');
  });

  it('merges nsight data into existing LLM profile builder', async () => {
    const builder = new ProfileBuilder('test-session');

    const data = await createTestDb((db) => {
      db.run("INSERT INTO StringIds VALUES (1, 'matmul_f32')");
      // Use the same column order as other kernel tests in this file
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
        demangledName INTEGER, start INTEGER, end INTEGER,
        deviceId INTEGER, streamId INTEGER, contextId INTEGER, correlationId INTEGER,
        gridX INTEGER, gridY INTEGER, gridZ INTEGER,
        blockX INTEGER, blockY INTEGER, blockZ INTEGER,
        staticSharedMemory INTEGER, dynamicSharedMemory INTEGER, registersPerThread INTEGER
      )`);
      db.run('INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (1, 1000000, 2000000, 0, 1, 0, 100, 128, 1, 1, 256, 1, 1, 0, 1024, 32)');
    });

    const imported = await importNsightSqlite(data, 'test');
    mergeImportedProfile(builder, imported);

    // LLM value types should still be present, plus GPU-specific ones
    const keys = builder.profile.value_types.map(vt => vt.key);
    expect(keys).toContain('wall_ms');       // shared between LLM and GPU
    expect(keys).toContain('input_tokens');  // LLM-only
    expect(keys).toContain('threads');       // GPU-only

    // GPU span should have 0 for LLM-only dimensions
    const gpuLane = builder.profile.lanes.find(l => l.id.includes('gpu-0-kernels'));
    if (!gpuLane) throw new Error('gpuLane not found');
    const span = gpuLane.spans[0];
    expect(span.values.length).toBe(builder.profile.value_types.length);

    const tokensIdx = builder.profile.value_types.findIndex(vt => vt.key === 'input_tokens');
    expect(span.values[tokensIdx]).toBe(0);

    const threadsIdx = builder.profile.value_types.findIndex(vt => vt.key === 'threads');
    expect(span.values[threadsIdx]).toBeGreaterThan(0);
  });
});
