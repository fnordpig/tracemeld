// src/model/state.ts
import { ProfileBuilder } from './profile.js';
import type { DetectedPattern } from './types.js';
import { PatternRegistry } from '../patterns/registry.js';
import { detectRetryLoop } from '../patterns/retry-loop.js';
import { detectRedundantRead } from '../patterns/redundant-read.js';
import { detectBlindEdit } from '../patterns/blind-edit.js';

export class ProfilerState {
  readonly builder: ProfileBuilder;
  readonly registry: PatternRegistry;
  readonly imported = new Map<string, ProfileBuilder>();
  private spanStacks = new Map<string, string[]>();
  activeLaneId = 'main';
  patternCache: DetectedPattern[] | null = null;
  private _nextSpanId = 0;
  private _nextMarkerId = 0;

  constructor() {
    this.builder = new ProfileBuilder('session');
    this.registry = new PatternRegistry();
    this.registry.register(detectRetryLoop);
    this.registry.register(detectRedundantRead);
    this.registry.register(detectBlindEdit);
  }

  nextSpanId(): string {
    return `s${this._nextSpanId++}`;
  }

  nextMarkerId(): string {
    return `m${this._nextMarkerId++}`;
  }

  pushSpan(laneId: string, spanId: string): void {
    let stack = this.spanStacks.get(laneId);
    if (!stack) {
      stack = [];
      this.spanStacks.set(laneId, stack);
    }
    stack.push(spanId);
    this.invalidatePatternCache();
  }

  popSpan(laneId: string): string | null {
    const stack = this.spanStacks.get(laneId);
    if (!stack || stack.length === 0) return null;
    this.invalidatePatternCache();
    return stack.pop() ?? null;
  }

  currentSpanId(laneId: string): string | null {
    const stack = this.spanStacks.get(laneId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1] ?? null;
  }

  spanDepth(laneId: string): number {
    return this.spanStacks.get(laneId)?.length ?? 0;
  }

  invalidatePatternCache(): void {
    this.patternCache = null;
    this.registry.invalidate();
  }
}
