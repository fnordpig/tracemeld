// src/importers/pprof.ts
import type { ImportedProfile } from './types.js';
import type { Sample, Unit } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';
import pako from 'pako';

export function importPprof(content: string, name: string): ImportedProfile {
  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i);
  }

  // Decompress if gzipped
  let decompressed: Uint8Array;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    decompressed = pako.ungzip(bytes);
  } else {
    decompressed = bytes;
  }

  const pprof = decodeProfile(decompressed);
  const frameTable = new FrameTable();
  const samples: Sample[] = [];

  const valueTypes = pprof.sampleTypes.map((st) => ({
    key: pprof.stringTable[st.type] ?? 'unknown',
    unit: mapUnit(pprof.stringTable[st.unit] ?? ''),
    description: `${pprof.stringTable[st.type] ?? ''} (${pprof.stringTable[st.unit] ?? ''})`,
  }));

  for (const sample of pprof.samples) {
    const stack: number[] = [];
    // location_ids are leaf-to-root, reverse for root-to-leaf
    for (let i = sample.locationIds.length - 1; i >= 0; i--) {
      const loc = pprof.locations.get(sample.locationIds[i]);
      if (!loc) continue;
      for (const line of loc.lines) {
        const func = pprof.functions.get(line.functionId);
        if (!func) continue;
        const funcName = pprof.stringTable[func.name] ?? '<unknown>';
        const fileName = pprof.stringTable[func.filename] || undefined;
        stack.push(frameTable.getOrInsert({
          name: funcName,
          file: fileName,
          line: line.line || undefined,
        }));
      }
    }
    samples.push({ timestamp: null, stack, values: sample.values });
  }

  return {
    format: 'pprof',
    profile: {
      id: crypto.randomUUID(),
      name,
      created_at: Date.now(),
      value_types: valueTypes,
      categories: [],
      frames: [...frameTable.frames],
      lanes: [{ id: 'main', name: 'main', kind: 'main', samples, spans: [], markers: [] }],
      metadata: { source_format: 'pprof' },
    },
  };
}

function mapUnit(unit: string): Unit {
  const map: Record<string, Unit> = {
    nanoseconds: 'nanoseconds',
    microseconds: 'microseconds',
    milliseconds: 'milliseconds',
    seconds: 'seconds',
    bytes: 'bytes',
  };
  return map[unit] ?? 'none';
}

// --- Protobuf wire format decoder ---

interface PprofData {
  stringTable: string[];
  sampleTypes: Array<{ type: number; unit: number }>;
  samples: Array<{ locationIds: number[]; values: number[] }>;
  locations: Map<number, { lines: Array<{ functionId: number; line: number }> }>;
  functions: Map<number, { name: number; filename: number }>;
}

class ProtoReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  hasMore(): boolean {
    return this.pos < this.data.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos++];
      // Use multiplication instead of bitwise shift to handle values > 2^28
      result += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  readTag(): { field: number; wireType: number } {
    const v = this.readVarint();
    return { field: Math.floor(v / 8), wireType: v % 8 };
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const result = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return result;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  readSubMessage(): ProtoReader {
    return new ProtoReader(this.readBytes());
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case 5:
        this.pos += 4;
        break;
    }
  }
}

function decodeProfile(data: Uint8Array): PprofData {
  const result: PprofData = {
    stringTable: [],
    sampleTypes: [],
    samples: [],
    locations: new Map(),
    functions: new Map(),
  };

  const reader = new ProtoReader(data);
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        result.sampleTypes.push(decodeSampleType(reader.readSubMessage()));
        break;
      case 2:
        result.samples.push(decodeSample(reader.readSubMessage()));
        break;
      case 4: {
        const loc = decodeLocation(reader.readSubMessage());
        result.locations.set(loc.id, { lines: loc.lines });
        break;
      }
      case 5: {
        const fn = decodeFunction(reader.readSubMessage());
        result.functions.set(fn.id, { name: fn.name, filename: fn.filename });
        break;
      }
      case 6:
        result.stringTable.push(reader.readString());
        break;
      default:
        reader.skip(wireType);
    }
  }

  return result;
}

function decodeSampleType(reader: ProtoReader): { type: number; unit: number } {
  let type = 0;
  let unit = 0;
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    if (field === 1) type = reader.readVarint();
    else if (field === 2) unit = reader.readVarint();
    else reader.skip(wireType);
  }
  return { type, unit };
}

function decodeSample(reader: ProtoReader): { locationIds: number[]; values: number[] } {
  const locationIds: number[] = [];
  const values: number[] = [];
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    if (field === 1) locationIds.push(reader.readVarint());
    else if (field === 2) values.push(reader.readVarint());
    else reader.skip(wireType);
  }
  return { locationIds, values };
}

function decodeLocation(reader: ProtoReader): { id: number; lines: Array<{ functionId: number; line: number }> } {
  let id = 0;
  const lines: Array<{ functionId: number; line: number }> = [];
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    if (field === 1) id = reader.readVarint();
    else if (field === 4) lines.push(decodeLine(reader.readSubMessage()));
    else reader.skip(wireType);
  }
  return { id, lines };
}

function decodeLine(reader: ProtoReader): { functionId: number; line: number } {
  let functionId = 0;
  let line = 0;
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    if (field === 1) functionId = reader.readVarint();
    else if (field === 2) line = reader.readVarint();
    else reader.skip(wireType);
  }
  return { functionId, line };
}

function decodeFunction(reader: ProtoReader): { id: number; name: number; filename: number } {
  let id = 0;
  let name = 0;
  let filename = 0;
  while (reader.hasMore()) {
    const { field, wireType } = reader.readTag();
    if (field === 1) id = reader.readVarint();
    else if (field === 2) name = reader.readVarint();
    else if (field === 4) filename = reader.readVarint();
    else reader.skip(wireType);
  }
  return { id, name, filename };
}
