// src/importers/import.ts
import type { ImportFormat, ImportedProfile } from './types.js';
import { detectFormat } from './detect.js';
import { importCollapsed } from './collapsed.js';
import { importChromeTrace } from './chrome-trace.js';
import { importGecko } from './gecko.js';
import { importPprof } from './pprof.js';
import { ProfileBuilder } from '../model/profile.js';

export interface ImportProfileResult {
  format_detected: string;
  lanes_added: number;
  frames_added: number;
  samples_added: number;
  spans_added: number;
  value_types: string[];
}

export function importProfile(
  content: string,
  name: string,
  formatHint: ImportFormat | 'auto' = 'auto',
  mergeInto?: ProfileBuilder,
): ImportProfileResult {
  const format = formatHint === 'auto' ? detectFormat(content) : formatHint;

  if (format === 'unknown') {
    throw new Error(`Unable to detect format for '${name}'. Format is unknown.`);
  }

  const imported = runImporter(content, name, format);

  let samplesAdded = 0;
  let spansAdded = 0;
  for (const lane of imported.profile.lanes) {
    samplesAdded += lane.samples.length;
    spansAdded += lane.spans.length;
  }

  const framesAdded = imported.profile.frames.length;
  const lanesAdded = imported.profile.lanes.length;
  const valueTypes = imported.profile.value_types.map((vt) => vt.key);

  if (mergeInto) {
    mergeImportedProfile(mergeInto, imported);
  }

  return {
    format_detected: format,
    lanes_added: lanesAdded,
    frames_added: framesAdded,
    samples_added: samplesAdded,
    spans_added: spansAdded,
    value_types: valueTypes,
  };
}

function runImporter(content: string, name: string, format: ImportFormat): ImportedProfile {
  switch (format) {
    case 'collapsed':
      return importCollapsed(content, name);
    case 'chrome_trace':
      return importChromeTrace(content, name);
    case 'gecko':
      return importGecko(content, name);
    case 'pprof':
      return importPprof(content, name);
    case 'speedscope':
      throw new Error(`Format '${format}' is not yet implemented`);
    default:
      throw new Error(`Unknown format: ${format as string}`);
  }
}

function mergeImportedProfile(builder: ProfileBuilder, imported: ImportedProfile): void {
  // Re-map frame indices from imported profile to the builder's frame table
  const frameIndexMap = new Map<number, number>();
  for (let i = 0; i < imported.profile.frames.length; i++) {
    const newIdx = builder.frameTable.getOrInsert(imported.profile.frames[i]);
    frameIndexMap.set(i, newIdx);
  }

  for (const lane of imported.profile.lanes) {
    const newLane = builder.addLane(`imported:${lane.id}`, lane.kind);
    newLane.name = lane.name;
    newLane.pid = lane.pid;
    newLane.tid = lane.tid;

    for (const sample of lane.samples) {
      newLane.samples.push({
        ...sample,
        stack: sample.stack.map((idx) => frameIndexMap.get(idx) ?? idx),
      });
    }

    for (const span of lane.spans) {
      newLane.spans.push({
        ...span,
        frame_index: frameIndexMap.get(span.frame_index) ?? span.frame_index,
      });
    }

    for (const marker of lane.markers) {
      newLane.markers.push({ ...marker });
    }
  }
}
