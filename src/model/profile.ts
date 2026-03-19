// src/model/profile.ts
import type { Profile, ValueType, Lane, LaneKind, Span, Sample, Marker, Frame } from './types.js';
import { LLM_VALUE_TYPES } from './types.js';
import { FrameTable } from './frame-table.js';

export class ProfileBuilder {
  readonly profile: Profile;
  readonly frameTable: FrameTable;
  private _valueTypeIndex: Map<string, number>;

  constructor(name: string, valueTypes?: ValueType[]) {
    const vt = valueTypes ?? [...LLM_VALUE_TYPES];
    this.frameTable = new FrameTable();

    this._valueTypeIndex = new Map();
    for (let i = 0; i < vt.length; i++) {
      this._valueTypeIndex.set(vt[i].key, i);
    }

    this.profile = {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: vt,
      categories: [],
      frames: this.frameTable.frames as Frame[],
      lanes: [],
      metadata: {},
    };

    // Create default main lane
    this.addLane('main', 'main');
  }

  addLane(id: string, kind: LaneKind = 'custom'): Lane {
    const lane: Lane = {
      id,
      name: id,
      kind,
      samples: [],
      spans: [],
      markers: [],
    };
    this.profile.lanes.push(lane);
    return lane;
  }

  getLane(id: string): Lane | undefined {
    return this.profile.lanes.find((l) => l.id === id);
  }

  addSpan(laneId: string, span: Span): Span {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.spans.push(span);
    return span;
  }

  addSample(laneId: string, sample: Sample): Sample {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.samples.push(sample);
    return sample;
  }

  addMarker(laneId: string, marker: Marker): Marker {
    const lane = this.getLane(laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    lane.markers.push(marker);
    return marker;
  }

  valueTypeIndex(key: string): number {
    return this._valueTypeIndex.get(key) ?? -1;
  }

  /** Build a zero-filled values array for the current value_types. */
  emptyValues(): number[] {
    return new Array<number>(this.profile.value_types.length).fill(0);
  }

  /** Merge a cost record into a values array. */
  mergeCost(values: number[], cost: Record<string, number>): void {
    for (const [key, val] of Object.entries(cost)) {
      const idx = this.valueTypeIndex(key);
      if (idx >= 0) values[idx] += val;
    }
  }
}
