// src/importers/nsight-sqlite.test.ts
import { describe, it, expect } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { importNsightSqlite } from './nsight-sqlite.js';
import type { Lane } from '../model/types.js';

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
        deviceId INTEGER, correlationId INTEGER, bytes INTEGER
      )`);
      db.run(`INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (
        1, 5000000, 6000000, 0, 200, 1048576
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
      db.run("INSERT INTO StringIds VALUES (1, 'cudaDeviceSynchronize')");
      db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_SYNCHRONIZATION (
        nameId INTEGER, start INTEGER, end INTEGER, correlationId INTEGER
      )`);
      db.run('INSERT INTO CUPTI_ACTIVITY_KIND_SYNCHRONIZATION VALUES (1, 10000000, 15000000, 300)');
    });

    const result = await importNsightSqlite(data, 'test.sqlite');
    const runtimeLane = findLane(result.profile.lanes, 'cuda-runtime');

    const syncSpan = runtimeLane.spans[0];
    const frame = result.profile.frames[syncSpan.frame_index];
    expect(frame.name).toBe('cuda_sync:cudaDeviceSynchronize');
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
});
