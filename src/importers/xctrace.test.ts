import { describe, it, expect } from 'vitest';
import { importXctraceRows } from './xctrace.js';
import type { Lane } from '../model/types.js';

function findLane(lanes: Lane[], id: string): Lane {
  const lane = lanes.find((l) => l.id === id);
  expect(lane, `lane '${id}' not found in [${lanes.map(l => l.id).join(', ')}]`).toBeDefined();
  return lane as Lane;
}

describe('importXctraceRows', () => {
  it('imports metal-gpu-intervals as spans in stage-specific lanes', () => {
    const schemaRows = new Map([
      ['metal-gpu-intervals', [
        {
          'start-time': '1000000000',
          'duration': '5000000',
          'gpu-channel-name': 'Compute',
          'formatted-label': 'Command Buffer 0:Compute Command 0 (ripvec)',
          'process': 'ripvec (4821)',
        },
        {
          'start-time': '2000000000',
          'duration': '3000000',
          'gpu-channel-name': 'Vertex',
          'formatted-label': 'Command Buffer 0:Render Command 0 (ghostty)',
          'process': 'ghostty (1709)',
        },
        {
          'start-time': '3000000000',
          'duration': '2000000',
          'gpu-channel-name': 'Fragment',
          'formatted-label': 'Command Buffer 0:Render Command 0 (ghostty)',
          'process': 'ghostty (1709)',
        },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');

    expect(result.format).toBe('xctrace');
    expect(result.profile.value_types).toHaveLength(1);
    expect(result.profile.value_types[0].key).toBe('wall_ms');

    const computeLane = findLane(result.profile.lanes, 'gpu-compute');
    expect(computeLane.spans).toHaveLength(1);
    const computeSpan = computeLane.spans[0];
    expect(result.profile.frames[computeSpan.frame_index].name).toBe(
      'gpu-compute:Command Buffer 0:Compute Command 0 (ripvec)',
    );
    expect(computeSpan.start_time).toBeCloseTo(1000);
    expect(computeSpan.values[0]).toBeCloseTo(5);

    const vertexLane = findLane(result.profile.lanes, 'gpu-vertex');
    expect(vertexLane.spans).toHaveLength(1);

    const fragmentLane = findLane(result.profile.lanes, 'gpu-fragment');
    expect(fragmentLane.spans).toHaveLength(1);
  });

  it('falls back to gpu-other lane for Blit channel', () => {
    const schemaRows = new Map([
      ['metal-gpu-intervals', [
        {
          'start-time': '1000000000',
          'duration': '2000000',
          'gpu-channel-name': 'Blit',
          'formatted-label': 'CopyTexture',
        },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');
    const otherLane = findLane(result.profile.lanes, 'gpu-other');
    expect(otherLane.spans).toHaveLength(1);
    expect(result.profile.frames[otherLane.spans[0].frame_index].name).toBe('gpu-other:CopyTexture');
  });

  it('uses channel name as label fallback when formatted-label is missing', () => {
    const schemaRows = new Map([
      ['metal-gpu-intervals', [
        {
          'start-time': '1000000000',
          'duration': '2000000',
          'gpu-channel-name': 'Compute',
        },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');
    const computeLane = findLane(result.profile.lanes, 'gpu-compute');
    expect(result.profile.frames[computeLane.spans[0].frame_index].name).toBe('gpu-compute:Compute');
  });

  it('returns empty profile when no schemas provided', () => {
    const result = importXctraceRows(new Map(), 'test.trace');
    expect(result.profile.lanes).toHaveLength(0);
  });

  it('imports metal-driver-event-intervals as driver lane', () => {
    const schemaRows = new Map([
      ['metal-driver-event-intervals', [
        {
          'start-time': '500000000',
          'duration': '10000000',
          'gpu-driver-name': 'Driver Processing',
          'formatted-label': 'Wire 32.00 KiB System Memory (Success)',
          'process': 'ripvec (4821)',
        },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');
    const driverLane = findLane(result.profile.lanes, 'driver');
    expect(driverLane.spans).toHaveLength(1);
    const span = driverLane.spans[0];
    expect(result.profile.frames[span.frame_index].name).toBe('driver:Driver Processing');
    expect(span.start_time).toBeCloseTo(500);
    expect(span.values[0]).toBeCloseTo(10);
  });

  it('imports os-signpost-interval as signpost lane', () => {
    const schemaRows = new Map([
      ['os-signpost-interval', [
        {
          'start-time': '800000000',
          'duration': '50000000',
          'subsystem': 'com.ripvec.gpu',
          'name': 'MPS MatMul Dispatch',
        },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');
    const signpostLane = findLane(result.profile.lanes, 'signpost');
    expect(signpostLane.spans).toHaveLength(1);
    expect(result.profile.frames[signpostLane.spans[0].frame_index].name).toBe(
      'signpost:com.ripvec.gpu:MPS MatMul Dispatch',
    );
    expect(signpostLane.spans[0].values[0]).toBeCloseTo(50);
  });

  it('combines multiple schemas into one profile', () => {
    const schemaRows = new Map([
      ['metal-gpu-intervals', [
        { 'start-time': '1000000000', 'duration': '5000000', 'gpu-channel-name': 'Compute', 'formatted-label': 'K1' },
      ]],
      ['metal-driver-event-intervals', [
        { 'start-time': '500000000', 'duration': '10000000', 'gpu-driver-name': 'Driver Processing', 'formatted-label': 'CB1' },
      ]],
      ['os-signpost-interval', [
        { 'start-time': '800000000', 'duration': '50000000', 'name': 'Phase1' },
      ]],
    ]);

    const result = importXctraceRows(schemaRows, 'test.trace');
    expect(result.profile.lanes).toHaveLength(3);
    expect(result.profile.lanes.map((l) => l.id).sort()).toEqual(['driver', 'gpu-compute', 'signpost']);
  });
});
