// src/exporters/collapsed.test.ts
import { describe, it, expect } from 'vitest';
import { exportCollapsed } from './collapsed.js';
import { importCollapsed } from '../importers/collapsed.js';

describe('exportCollapsed', () => {
  it('exports samples as collapsed stacks', () => {
    const input = 'main;foo;bar 10\nmain;foo;baz 20\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);
    expect(output).toContain('main;foo;bar 10');
    expect(output).toContain('main;foo;baz 20');
  });

  it('round-trips collapsed stacks', () => {
    const input = 'a;b;c 5\nx;y 15\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);
    const lines = output.trim().split('\n').sort();
    const expectedLines = input.trim().split('\n').sort();
    expect(lines).toEqual(expectedLines);
  });

  it('exports spans as collapsed stacks using ancestry', () => {
    const profile = importCollapsed('a;b 10\n', 'test.txt').profile;
    // Add a span-based lane
    profile.lanes.push({
      id: 'spans',
      name: 'spans',
      kind: 'worker',
      samples: [],
      spans: [
        {
          id: 's1',
          frame_index: 0, // 'a'
          parent_id: null,
          start_time: 0,
          end_time: 100,
          values: [100],
          args: {},
          children: ['s2'],
        },
        {
          id: 's2',
          frame_index: 1, // 'b'
          parent_id: 's1',
          start_time: 0,
          end_time: 50,
          values: [50],
          args: {},
          children: [],
        },
      ],
      markers: [],
    });
    const output = exportCollapsed(profile);
    expect(output).toContain('a;b 50');
  });

  it('uses first value type as weight by default', () => {
    const input = 'main;foo 10\n';
    const imported = importCollapsed(input, 'test.txt');
    const output = exportCollapsed(imported.profile);
    expect(output.trim()).toBe('main;foo 10');
  });

  it('returns empty string for empty profile', () => {
    const imported = importCollapsed('', 'test.txt');
    const output = exportCollapsed(imported.profile);
    expect(output.trim()).toBe('');
  });
});
