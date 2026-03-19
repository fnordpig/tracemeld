// src/importers/gecko.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importGecko } from './gecko.js';

describe('importGecko', () => {
  function loadFixture(): string {
    return readFileSync('fixtures/gecko/simple.json', 'utf-8');
  }

  it('imports a gecko profile', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.format).toBe('gecko');
    expect(result.profile.lanes.length).toBeGreaterThanOrEqual(1);
    expect(result.profile.lanes[0].name).toBe('main');
  });

  it('creates samples from the samples table', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.lanes[0].samples.length).toBe(4);
  });

  it('resolves function names through the chain', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const frameNames = result.profile.frames.map((f) => f.name);
    expect(frameNames).toContain('main');
    expect(frameNames).toContain('doWork');
    expect(frameNames).toContain('compute');
    expect(frameNames).toContain('render');
  });

  it('builds correct stack from prefix tree', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const sample0 = result.profile.lanes[0].samples[0];
    const stack0Names = sample0.stack.map((idx) => result.profile.frames[idx].name);
    expect(stack0Names).toEqual(['main', 'doWork', 'compute']);
  });

  it('uses wall_ms as the value type', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.value_types[0].key).toBe('wall_ms');
  });

  it('imports categories from meta', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.categories.length).toBe(2);
    expect(result.profile.categories[0].name).toBe('Other');
  });

  it('sets profile name from meta.product', () => {
    const result = importGecko(loadFixture(), 'test.json');
    expect(result.profile.name).toBe('test-app');
  });

  it('marks the main thread lane as main kind', () => {
    const result = importGecko(loadFixture(), 'test.json');
    const mainLane = result.profile.lanes.find((l) => l.name === 'main');
    expect(mainLane?.kind).toBe('main');
  });
});
