// src/importers/collapsed.test.ts
import { describe, it, expect } from 'vitest';
import { importCollapsed } from './collapsed.js';

describe('importCollapsed', () => {
  it('parses simple collapsed stacks', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.format).toBe('collapsed');
    expect(result.profile.value_types).toHaveLength(1);
    expect(result.profile.value_types[0].key).toBe('weight');
    expect(result.profile.lanes).toHaveLength(1);
    expect(result.profile.lanes[0].name).toBe('main');
  });

  it('creates correct samples', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');
    const samples = result.profile.lanes[0].samples;
    expect(samples).toHaveLength(2);
    expect(samples[0].values).toEqual([10]);
    expect(samples[1].values).toEqual([20]);
    expect(samples[0].timestamp).toBeNull();
  });

  it('deduplicates frames', () => {
    const content = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.frames.length).toBe(4);
  });

  it('builds correct stack indices', () => {
    const content = 'a;b;c 5\n';
    const result = importCollapsed(content, 'test.txt');
    const sample = result.profile.lanes[0].samples[0];
    expect(sample.stack).toHaveLength(3);
    expect(result.profile.frames[sample.stack[0]].name).toBe('a');
    expect(result.profile.frames[sample.stack[1]].name).toBe('b');
    expect(result.profile.frames[sample.stack[2]].name).toBe('c');
  });

  it('handles empty lines and whitespace', () => {
    const content = '\n  main;foo 10  \n\n  main;bar 20\n\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.lanes[0].samples).toHaveLength(2);
  });

  it('handles single-frame stacks', () => {
    const content = 'main 100\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.lanes[0].samples).toHaveLength(1);
    expect(result.profile.lanes[0].samples[0].stack).toHaveLength(1);
  });

  it('preserves special characters in frame names', () => {
    const content = 'module`func (file.rs:42) 10\n';
    const result = importCollapsed(content, 'test.txt');
    expect(result.profile.frames[0].name).toBe('module`func (file.rs:42)');
  });
});
