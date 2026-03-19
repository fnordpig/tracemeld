// src/model/types.ts

export type Unit =
  | 'nanoseconds'
  | 'microseconds'
  | 'milliseconds'
  | 'seconds'
  | 'bytes'
  | 'none';

export interface ValueType {
  key: string;
  unit: Unit;
  description?: string;
}

export interface Category {
  name: string;
  color?: string;
  subcategories?: string[];
}

export interface Frame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
  category_index?: number;
  metadata?: Record<string, unknown>;
}

export interface Sample {
  timestamp: number | null;
  stack: number[];
  values: number[];
  labels?: Record<string, string | number>[];
}

export interface Span {
  id: string;
  frame_index: number;
  parent_id: string | null;
  start_time: number;
  end_time: number;
  values: number[];
  args: Record<string, unknown>;
  error?: string;
  children: string[];
}

export interface Marker {
  timestamp: number;
  name: string;
  category_index?: number;
  severity?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
  end_time?: number;
}

export type LaneKind = 'main' | 'worker' | 'agent' | 'subprocess' | 'custom';

export interface Lane {
  id: string;
  name: string;
  pid?: number;
  tid?: number;
  kind: LaneKind;
  samples: Sample[];
  spans: Span[];
  markers: Marker[];
}

export interface Profile {
  id: string;
  name: string;
  created_at: number;
  value_types: ValueType[];
  categories: Category[];
  frames: Frame[];
  lanes: Lane[];
  metadata: Record<string, unknown>;
}

export interface DetectedPattern {
  name: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  evidence: Record<string, unknown>;
  span_ids?: string[];
}

export const LLM_VALUE_TYPES: ValueType[] = [
  { key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' },
  { key: 'input_tokens', unit: 'none', description: 'Input/prompt tokens consumed' },
  { key: 'output_tokens', unit: 'none', description: 'Output/completion tokens generated' },
  { key: 'cost_usd', unit: 'none', description: 'Estimated dollar cost' },
  { key: 'bytes_read', unit: 'bytes', description: 'Bytes read from disk/network' },
  { key: 'bytes_written', unit: 'bytes', description: 'Bytes written to disk/network' },
];
