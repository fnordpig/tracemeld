// src/importers/import.ts
import type { ImportFormat, ImportedProfile } from './types.js';
import { detectFormat } from './detect.js';
import { importCollapsed, type CollapsedOptions } from './collapsed.js';
import { importChromeTrace } from './chrome-trace.js';
import { importGecko } from './gecko.js';
import { importPprof } from './pprof.js';
import { ProfileBuilder } from '../model/profile.js';

export interface ImportOptions {
  /** Options passed to the collapsed importer when format is 'collapsed'. */
  collapsed?: CollapsedOptions;
}

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
  symsJson?: string,
  options?: ImportOptions,
): ImportProfileResult {
  const format = formatHint === 'auto' ? detectFormat(content) : formatHint;

  if (format === 'unknown') {
    throw new Error(`Unable to detect format for '${name}'. Format is unknown.`);
  }

  const imported = runImporter(content, name, format, symsJson, options);
  const result = buildImportResult(imported);

  if (mergeInto) {
    mergeImportedProfile(mergeInto, imported);
  }

  return result;
}

function runImporter(content: string, name: string, format: ImportFormat, symsJson?: string, options?: ImportOptions): ImportedProfile {
  switch (format) {
    case 'collapsed':
      return importCollapsed(content, name, options?.collapsed);
    case 'chrome_trace':
      return importChromeTrace(content, name);
    case 'gecko':
      return importGecko(content, name, symsJson);
    case 'pprof':
      return importPprof(content, name);
    case 'nsight_sqlite':
    case 'speedscope':
      throw new Error(`Format '${format}' is not yet implemented`);
    default:
      throw new Error(`Unknown format: ${format as string}`);
  }
}

export function buildImportResult(imported: ImportedProfile): ImportProfileResult {
  let samplesAdded = 0;
  let spansAdded = 0;
  for (const lane of imported.profile.lanes) {
    samplesAdded += lane.samples.length;
    spansAdded += lane.spans.length;
  }
  return {
    format_detected: imported.format,
    lanes_added: imported.profile.lanes.length,
    frames_added: imported.profile.frames.length,
    samples_added: samplesAdded,
    spans_added: spansAdded,
    value_types: imported.profile.value_types.map((vt) => vt.key),
  };
}

export function mergeImportedProfile(builder: ProfileBuilder, imported: ImportedProfile): void {
  // Reconcile value types: build a mapping from imported indices to builder indices
  const valueIndexMap = new Map<number, number>();
  for (let i = 0; i < imported.profile.value_types.length; i++) {
    const builderIdx = builder.addValueType(imported.profile.value_types[i]);
    valueIndexMap.set(i, builderIdx);
  }

  // Remap a values array from imported indices to builder indices
  function remapValues(importedValues: number[]): number[] {
    const result = builder.emptyValues();
    for (let i = 0; i < importedValues.length; i++) {
      const targetIdx = valueIndexMap.get(i);
      if (targetIdx !== undefined && targetIdx < result.length) {
        result[targetIdx] = importedValues[i];
      }
    }
    return result;
  }

  // Re-map frame indices from imported profile to the builder's frame table
  const frameIndexMap = new Map<number, number>();
  for (let i = 0; i < imported.profile.frames.length; i++) {
    const newIdx = builder.frameTable.getOrInsert(imported.profile.frames[i]);
    frameIndexMap.set(i, newIdx);
  }

  // Add lanes with remapped frames and values
  for (const lane of imported.profile.lanes) {
    const newLane = builder.addLane(`imported:${lane.id}`, lane.kind);
    newLane.name = lane.name;
    newLane.pid = lane.pid;
    newLane.tid = lane.tid;

    for (const sample of lane.samples) {
      newLane.samples.push({
        ...sample,
        stack: sample.stack.map((idx) => frameIndexMap.get(idx) ?? idx),
        values: remapValues(sample.values),
      });
    }

    for (const span of lane.spans) {
      newLane.spans.push({
        ...span,
        frame_index: frameIndexMap.get(span.frame_index) ?? span.frame_index,
        values: remapValues(span.values),
      });
    }

    for (const marker of lane.markers) {
      newLane.markers.push({ ...marker });
    }
  }
}
