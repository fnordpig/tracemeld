// src/instrument/mark.ts
import type { ProfilerState } from '../model/state.js';

export interface MarkInput {
  what: string;
  severity?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface MarkResult {
  marker_id: string;
  timestamp: number;
}

export function handleMark(state: ProfilerState, input: MarkInput): MarkResult {
  const laneId = state.activeLaneId;
  const markerId = state.nextMarkerId();
  const timestamp = Date.now();

  state.builder.addMarker(laneId, {
    timestamp,
    name: input.what,
    severity: input.severity ?? 'info',
    data: input.data,
  });

  return { marker_id: markerId, timestamp };
}
