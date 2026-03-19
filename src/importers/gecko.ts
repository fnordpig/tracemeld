// src/importers/gecko.ts
import type { ImportedProfile } from './types.js';
import type { Sample, Lane, Category } from '../model/types.js';
import { FrameTable } from '../model/frame-table.js';

interface GeckoThread {
  name: string;
  isMainThread?: boolean;
  pid: number;
  tid: number;
  samples: {
    length: number;
    stack: (number | null)[];
    timeDeltas: number[];
    weight: number[];
  };
  stackTable: { length: number; prefix: (number | null)[]; frame: number[] };
  frameTable: {
    length: number;
    func: number[];
    line: (number | null)[];
    column: (number | null)[];
    category: number[];
    address?: number[];
    nativeSymbol?: (number | null)[];
  };
  funcTable: {
    length: number;
    name: number[];
    resource?: number[];
    fileName?: (number | null)[];
    lineNumber?: (number | null)[];
    columnNumber?: (number | null)[];
  };
  resourceTable?: {
    length: number;
    lib: (number | null)[];
    name: number[];
  };
  stringArray: string[];
}

interface GeckoLib {
  name: string;
  debugName: string;
  breakpadId: string;
}

interface GeckoProfile {
  meta: {
    version: number;
    interval: number;
    startTime: number;
    product?: string;
    categories?: Array<{ name: string; color?: string; subcategories?: string[] }>;
  };
  libs: GeckoLib[];
  threads: GeckoThread[];
}

// --- Sidecar symbolication types ---

interface SymsSidecar {
  string_table: string[];
  data: SymsLibrary[];
}

interface SymsLibrary {
  debug_name: string;
  debug_id: string;
  symbol_table: SymsSymbol[];
  known_addresses: [number, number][]; // [address, symbol_table_index]
}

interface SymsSymbol {
  rva: number;
  size: number;
  symbol: number; // index into string_table
  frames?: SymsInlineFrame[];
}

interface SymsInlineFrame {
  function: number; // index into string_table
  file?: number;    // index into string_table
  line?: number;
}

interface ResolvedSymbol {
  name: string;
  file?: string;
  line?: number;
}

/**
 * Import a Gecko Profiler JSON file.
 *
 * @param content - The profile JSON content
 * @param name - Profile name
 * @param symsJson - Optional contents of a .syms.json sidecar file from samply --unstable-presymbolicate.
 *                   When provided, hex addresses in the profile are resolved to function names.
 */
export function importGecko(content: string, name: string, symsJson?: string): ImportedProfile {
  const gecko = JSON.parse(content) as GeckoProfile;
  const frameTable = new FrameTable();
  const lanes: Lane[] = [];
  const categories: Category[] = (gecko.meta.categories ?? []).map((c) => ({
    name: c.name,
    color: c.color,
    subcategories: c.subcategories,
  }));

  // Build symbol resolver from sidecar if available
  const resolver = symsJson ? buildSymbolResolver(symsJson) : null;

  // If we have a resolver, pre-symbolicate each thread's stringArray
  if (resolver) {
    for (const thread of gecko.threads) {
      symbolicateThread(thread, gecko.libs, resolver);
    }
  }

  for (const thread of gecko.threads) {
    if (thread.samples.length === 0) continue;
    const samples: Sample[] = [];
    let cumulativeTime = 0;

    for (let i = 0; i < thread.samples.length; i++) {
      cumulativeTime += thread.samples.timeDeltas[i] ?? 0;
      const stackIdx = thread.samples.stack[i];
      const stack = resolveStack(thread, frameTable, stackIdx);
      const weight = thread.samples.weight[i] ?? 1;
      samples.push({
        timestamp: gecko.meta.startTime + cumulativeTime,
        stack,
        values: [weight * gecko.meta.interval],
      });
    }

    lanes.push({
      id: `${thread.pid}:${thread.tid}`,
      name: thread.name,
      pid: thread.pid,
      tid: thread.tid,
      kind: thread.isMainThread === true ? 'main' : 'worker',
      samples,
      spans: [],
      markers: [],
    });
  }

  return {
    format: 'gecko',
    profile: {
      id: crypto.randomUUID(),
      name: gecko.meta.product ?? name,
      created_at: gecko.meta.startTime,
      value_types: [{ key: 'wall_ms', unit: 'milliseconds', description: 'Wall-clock duration' }],
      categories,
      frames: [...frameTable.frames],
      lanes,
      metadata: { source_format: 'gecko', version: gecko.meta.version },
    },
  };
}

function resolveStack(thread: GeckoThread, frameTable: FrameTable, stackIdx: number | null): number[] {
  const frameIndices: number[] = [];
  let current = stackIdx;
  while (current != null) {
    const frameIdx = thread.stackTable.frame[current];
    const funcIdx = thread.frameTable.func[frameIdx];
    const nameIdx = thread.funcTable.name[funcIdx];
    const funcName = thread.stringArray[nameIdx] ?? `<unknown ${funcIdx}>`;

    const fileNameIdx = thread.funcTable.fileName?.[funcIdx];
    const file = fileNameIdx != null ? (thread.stringArray[fileNameIdx] ?? undefined) : undefined;

    const line = thread.funcTable.lineNumber?.[funcIdx] ?? undefined;
    const col = thread.funcTable.columnNumber?.[funcIdx] ?? undefined;
    const category = thread.frameTable.category[frameIdx];

    frameIndices.push(
      frameTable.getOrInsert({
        name: funcName,
        file,
        line: line ?? undefined,
        col: col ?? undefined,
        category_index: category,
      }),
    );
    current = thread.stackTable.prefix[current];
  }
  frameIndices.reverse();
  return frameIndices;
}

// --- Sidecar symbolication ---

/**
 * Build a symbol resolver from the .syms.json sidecar.
 * Returns a map: normalized debug_id → (address → ResolvedSymbol)
 */
function buildSymbolResolver(
  symsJsonContent: string,
): Map<string, Map<number, ResolvedSymbol>> {
  const sidecar = JSON.parse(symsJsonContent) as SymsSidecar;
  const resolver = new Map<string, Map<number, ResolvedSymbol>>();

  for (const libData of sidecar.data) {
    const addressMap = new Map<number, ResolvedSymbol>();

    for (const [address, symbolIdx] of libData.known_addresses) {
      const sym = libData.symbol_table[symbolIdx] as SymsSymbol | undefined;
      if (!sym) continue;

      const name = sidecar.string_table[sym.symbol] ?? '<unknown>';

      // Use the first inline frame if available (most specific)
      let file: string | undefined;
      let line: number | undefined;
      if (sym.frames && sym.frames.length > 0) {
        const topFrame = sym.frames[0];
        file = topFrame.file != null ? sidecar.string_table[topFrame.file] : undefined;
        line = topFrame.line;
      }

      addressMap.set(address, { name, file, line });
    }

    // Normalize debug_id: sidecar uses lowercase with dashes, profile breakpadId is uppercase no dashes with trailing 0
    const normalizedId = libData.debug_id.toLowerCase().replace(/-/g, '');
    resolver.set(normalizedId, addressMap);
  }

  return resolver;
}

/**
 * Symbolicate a thread's stringArray in-place.
 * Replaces hex address strings (e.g., "0x8d53") with resolved function names.
 */
function symbolicateThread(
  thread: GeckoThread,
  libs: GeckoLib[],
  resolver: Map<string, Map<number, ResolvedSymbol>>,
): void {
  // For each func in funcTable, determine which lib it belongs to via resourceTable → lib
  // Then look up the address in the resolver

  // But the simpler approach: the stringArray contains hex addresses like "0x8d53"
  // and the frameTable has an address field. The address in the sidecar's known_addresses
  // matches the hex value in stringArray.

  // We need to know which lib each frame belongs to. This comes from:
  // funcTable.resource[funcIdx] → resourceTable.lib[resourceIdx] → libs[libIdx].breakpadId

  for (let funcIdx = 0; funcIdx < thread.funcTable.length; funcIdx++) {
    const nameIdx = thread.funcTable.name[funcIdx];
    const currentName = thread.stringArray[nameIdx];
    if (!currentName || !currentName.startsWith('0x')) continue;

    // Parse the hex address
    const address = parseInt(currentName, 16);
    if (isNaN(address)) continue;

    // Determine which library this function belongs to
    const libIdx = getLibForFunc(thread, funcIdx);
    if (libIdx == null) continue;

    const lib = libs[libIdx] as GeckoLib | undefined;
    if (!lib) continue;

    // Normalize the breakpadId to match the sidecar's debug_id format
    const normalizedId = lib.breakpadId.toLowerCase().replace(/0$/, '');
    const addressMap = resolver.get(normalizedId);
    if (!addressMap) continue;

    const resolved = addressMap.get(address);
    if (!resolved) continue;

    // Replace the hex address with the resolved name in stringArray
    thread.stringArray[nameIdx] = resolved.name;

    // Also set file/line if available and not already set
    if (resolved.file && thread.funcTable.fileName) {
      if (thread.funcTable.fileName[funcIdx] == null) {
        // Add the file path to stringArray and reference it
        const fileIdx = thread.stringArray.length;
        thread.stringArray.push(resolved.file);
        thread.funcTable.fileName[funcIdx] = fileIdx;
      }
    }
    if (resolved.line != null && thread.funcTable.lineNumber) {
      if (thread.funcTable.lineNumber[funcIdx] == null) {
        thread.funcTable.lineNumber[funcIdx] = resolved.line;
      }
    }
  }
}

/**
 * Determine which lib index a function belongs to via resourceTable.
 */
function getLibForFunc(thread: GeckoThread, funcIdx: number): number | null {
  const resourceIdx = thread.funcTable.resource?.[funcIdx];
  if (resourceIdx == null || resourceIdx < 0) return null;

  if (!thread.resourceTable) return null;
  const libIdx = thread.resourceTable.lib[resourceIdx];
  if (libIdx == null || libIdx < 0) return null;

  return libIdx;
}
