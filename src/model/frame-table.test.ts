// src/model/frame-table.test.ts
import { describe, it, expect } from 'vitest';
import { FrameTable } from './frame-table.js';

describe('FrameTable', () => {
  it('returns index 0 for the first inserted frame', () => {
    const table = new FrameTable();
    const idx = table.getOrInsert({ name: 'bash:npm test' });
    expect(idx).toBe(0);
  });

  it('returns the same index for duplicate frames', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'bash:npm test' });
    const idx2 = table.getOrInsert({ name: 'bash:npm test' });
    expect(idx1).toBe(idx2);
  });

  it('returns different indices for different frames', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'bash:npm test' });
    const idx2 = table.getOrInsert({ name: 'file_read:src/auth.ts' });
    expect(idx1).not.toBe(idx2);
  });

  it('deduplicates by name+file+line+col+category', () => {
    const table = new FrameTable();
    const idx1 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 10 });
    const idx2 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 10 });
    const idx3 = table.getOrInsert({ name: 'foo', file: 'a.ts', line: 20 });
    expect(idx1).toBe(idx2);
    expect(idx1).not.toBe(idx3);
  });

  it('exposes frames as a readonly array', () => {
    const table = new FrameTable();
    table.getOrInsert({ name: 'a' });
    table.getOrInsert({ name: 'b' });
    expect(table.frames).toHaveLength(2);
    expect(table.frames[0].name).toBe('a');
    expect(table.frames[1].name).toBe('b');
  });
});
