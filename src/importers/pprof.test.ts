// src/importers/pprof.test.ts
import { describe, it, expect } from 'vitest';
import pako from 'pako';
import { importPprof } from './pprof.js';

function buildMinimalPprof(): Uint8Array {
  const buf: number[] = [];

  function writeVarint(value: number): void {
    let v = value >>> 0;
    while (v > 0x7f) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v & 0x7f);
  }

  function writeTag(field: number, wireType: number): void {
    writeVarint((field << 3) | wireType);
  }

  function writeBytes(field: number, data: Uint8Array): void {
    writeTag(field, 2);
    writeVarint(data.length);
    for (const b of data) buf.push(b);
  }

  function writeString(field: number, str: string): void {
    writeBytes(field, new TextEncoder().encode(str));
  }

  function writeVarintField(field: number, value: number): void {
    writeTag(field, 0);
    writeVarint(value);
  }

  function encodeSubmessage(fn: () => void): Uint8Array {
    const saved = buf.splice(0);
    fn();
    const result = new Uint8Array(buf.splice(0));
    buf.push(...saved);
    return result;
  }

  // String table (field 6)
  const strings = ['', 'samples', 'count', 'cpu', 'nanoseconds', 'main', 'doWork', 'compute', 'main.go', 'work.go'];
  for (const s of strings) { writeString(6, s); }

  // sample_type (field 1)
  writeBytes(1, encodeSubmessage(() => { writeVarintField(1, 1); writeVarintField(2, 2); }));
  writeBytes(1, encodeSubmessage(() => { writeVarintField(1, 3); writeVarintField(2, 4); }));

  // function (field 5)
  writeBytes(5, encodeSubmessage(() => { writeVarintField(1, 1); writeVarintField(2, 5); writeVarintField(4, 8); }));
  writeBytes(5, encodeSubmessage(() => { writeVarintField(1, 2); writeVarintField(2, 6); writeVarintField(4, 9); }));
  writeBytes(5, encodeSubmessage(() => { writeVarintField(1, 3); writeVarintField(2, 7); writeVarintField(4, 9); }));

  // location (field 4)
  const line1 = encodeSubmessage(() => { writeVarintField(1, 1); writeVarintField(2, 10); });
  writeBytes(4, encodeSubmessage(() => { writeVarintField(1, 1); writeBytes(4, line1); }));
  const line2 = encodeSubmessage(() => { writeVarintField(1, 2); writeVarintField(2, 20); });
  writeBytes(4, encodeSubmessage(() => { writeVarintField(1, 2); writeBytes(4, line2); }));
  const line3 = encodeSubmessage(() => { writeVarintField(1, 3); writeVarintField(2, 30); });
  writeBytes(4, encodeSubmessage(() => { writeVarintField(1, 3); writeBytes(4, line3); }));

  // sample (field 2): location_ids [3,2,1] (leaf-to-root), values [1, 10000000]
  writeBytes(2, encodeSubmessage(() => {
    writeVarintField(1, 3); writeVarintField(1, 2); writeVarintField(1, 1);
    writeVarintField(2, 1); writeVarintField(2, 10000000);
  }));

  return new Uint8Array(buf);
}

describe('importPprof', () => {
  it('imports a pprof profile from gzipped protobuf', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');
    expect(result.format).toBe('pprof');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].samples.length).toBeGreaterThan(0);
  });

  it('resolves function names from string table', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');
    const frameNames = result.profile.frames.map((f) => f.name);
    expect(frameNames).toContain('main');
    expect(frameNames).toContain('doWork');
    expect(frameNames).toContain('compute');
  });

  it('extracts value types from sample_type', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');
    expect(result.profile.value_types).toHaveLength(2);
    expect(result.profile.value_types[0].key).toBe('samples');
    expect(result.profile.value_types[1].key).toBe('cpu');
  });

  it('builds correct stack order (root to leaf)', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');
    const sample = result.profile.lanes[0].samples[0];
    const stackNames = sample.stack.map((idx) => result.profile.frames[idx].name);
    expect(stackNames).toEqual(['main', 'doWork', 'compute']);
  });

  it('extracts file and line from functions', () => {
    const raw = buildMinimalPprof();
    const gzipped = pako.gzip(raw);
    const content = Buffer.from(gzipped).toString('binary');
    const result = importPprof(content, 'cpu.pb.gz');
    const mainFrame = result.profile.frames.find((f) => f.name === 'main');
    expect(mainFrame?.file).toBe('main.go');
    expect(mainFrame?.line).toBe(10);
  });
});
