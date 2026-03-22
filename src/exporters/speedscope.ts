// src/exporters/speedscope.ts
import type { Profile, Frame, Unit } from '../model/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as { version: string };

// --- Speedscope format types ---

type SpeedscopeUnit = 'none' | 'nanoseconds' | 'microseconds' | 'milliseconds' | 'seconds' | 'bytes';

interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

interface OpenFrameEvent {
  type: 'O';
  at: number;
  frame: number;
}

interface CloseFrameEvent {
  type: 'C';
  at: number;
  frame: number;
}

interface EventedProfile {
  type: 'evented';
  name: string;
  unit: SpeedscopeUnit;
  startValue: number;
  endValue: number;
  events: (OpenFrameEvent | CloseFrameEvent)[];
}

interface SampledProfile {
  type: 'sampled';
  name: string;
  unit: SpeedscopeUnit;
  startValue: number;
  endValue: number;
  samples: number[][];
  weights: number[];
}

interface SpeedscopeFile {
  $schema: string;
  exporter: string;
  name: string;
  activeProfileIndex: number;
  shared: { frames: SpeedscopeFrame[] };
  profiles: (EventedProfile | SampledProfile)[];
}

// --- Helpers ---

function mapUnit(unit: Unit): SpeedscopeUnit {
  return unit;
}

function mapFrame(frame: Frame): SpeedscopeFrame {
  const out: SpeedscopeFrame = { name: frame.name };
  if (frame.file !== undefined) out.file = frame.file;
  if (frame.line !== undefined) out.line = frame.line;
  if (frame.col !== undefined) out.col = frame.col;
  return out;
}

// --- Exporter ---

export interface SpeedscopeExportOptions {
  includeIdle?: boolean;
}

export function exportSpeedscope(profile: Profile, options?: SpeedscopeExportOptions): string {
  const includeIdle = options?.includeIdle ?? false;

  // Build shared frames from Profile.frames
  const sharedFrames: SpeedscopeFrame[] = profile.frames.map(mapFrame);

  const profiles: (EventedProfile | SampledProfile)[] = [];

  // For each lane × value_type, generate profiles
  for (const lane of profile.lanes) {
    for (let dimIdx = 0; dimIdx < profile.value_types.length; dimIdx++) {
      const vt = profile.value_types[dimIdx];
      const unit = mapUnit(vt.unit);
      const profileName = `${lane.name} \u2014 ${vt.description ?? vt.key}`;

      // Spans → EventedProfile
      if (lane.spans.length > 0) {
        const events: (OpenFrameEvent | CloseFrameEvent)[] = [];

        for (const span of lane.spans) {
          // Idle filtering: skip spans whose frame name starts with "user_input:"
          if (!includeIdle) {
            const frame = profile.frames[span.frame_index];
            if (frame && frame.name.startsWith('user_input:')) {
              continue;
            }
          }

          events.push({ type: 'O', at: span.start_time, frame: span.frame_index });
          events.push({ type: 'C', at: span.end_time, frame: span.frame_index });
        }

        if (events.length > 0) {
          // Sort by `at` value; for ties, close events before open events
          events.sort((a, b) => {
            if (a.at !== b.at) return a.at - b.at;
            // 'C' < 'O' alphabetically, which gives closes before opens at same timestamp
            return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
          });

          const startValue = events[0].at;
          const endValue = events[events.length - 1].at;

          profiles.push({
            type: 'evented',
            name: profileName,
            unit,
            startValue,
            endValue,
            events,
          });
        }
      }

      // Samples → SampledProfile
      if (lane.samples.length > 0) {
        const samples: number[][] = [];
        const weights: number[] = [];

        for (const sample of lane.samples) {
          samples.push(sample.stack);
          weights.push(sample.values[dimIdx] ?? 0);
        }

        if (samples.length > 0) {
          const timestamps = lane.samples
            .map((s) => s.timestamp)
            .filter((t): t is number => t !== null);
          const startValue = timestamps.length > 0 ? Math.min(...timestamps) : 0;
          const endValue = timestamps.length > 0 ? Math.max(...timestamps) : 0;

          profiles.push({
            type: 'sampled',
            name: profileName,
            unit,
            startValue,
            endValue,
            samples,
            weights,
          });
        }
      }
    }
  }

  const file: SpeedscopeFile = {
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    exporter: `tracemeld@${pkg.version}`,
    name: profile.name,
    activeProfileIndex: 0,
    shared: { frames: sharedFrames },
    profiles,
  };

  return JSON.stringify(file, null, 2);
}
