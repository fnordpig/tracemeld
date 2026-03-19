// src/model/frame-table.ts
import type { Frame } from './types.js';

export class FrameTable {
  private _frames: Frame[] = [];
  private _index = new Map<string, number>();

  private key(frame: Frame): string {
    return `${frame.name}\0${frame.file ?? ''}\0${frame.line ?? ''}\0${frame.col ?? ''}\0${frame.category_index ?? ''}`;
  }

  getOrInsert(frame: Frame): number {
    const k = this.key(frame);
    const existing = this._index.get(k);
    if (existing !== undefined) return existing;

    const idx = this._frames.length;
    this._frames.push({ ...frame });
    this._index.set(k, idx);
    return idx;
  }

  get(index: number): Frame | undefined {
    return this._frames[index];
  }

  get frames(): readonly Frame[] {
    return this._frames;
  }

  get length(): number {
    return this._frames.length;
  }
}
