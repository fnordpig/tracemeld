import { XMLParser } from 'fast-xml-parser';

export type XctraceRow = Record<string, string>;

/**
 * Parse xctrace XML export with id/ref deduplication resolution.
 *
 * The xctrace CLI exports `<trace-query-result>` XML where the first
 * occurrence of a repeated entity carries `id="N"` with full data,
 * and later occurrences use `ref="N"` to point back.  This function
 * resolves all refs and returns flat rows of tag→value mappings.
 *
 * Value resolution: text content is preferred when present; fmt
 * attribute is used as fallback (e.g. for elements whose text is
 * a nested child element rather than character data).
 */
export function parseXctraceXml(xml: string): XctraceRow[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (name) => name === 'row' || name === 'node',
  });

  const doc = parser.parse(xml) as Record<string, unknown>;
  const result = doc['trace-query-result'] as Record<string, unknown> | undefined;
  if (!result) return [];

  const nodes: unknown[] = Array.isArray(result['node'])
    ? (result['node'] as unknown[])
    : result['node']
      ? [result['node']]
      : [];

  const refMap = new Map<string, string>();
  const rows: XctraceRow[] = [];

  for (const node of nodes) {
    const nodeObj = node as Record<string, unknown>;
    const rawRows: unknown[] = Array.isArray(nodeObj['row'])
      ? (nodeObj['row'] as unknown[])
      : nodeObj['row']
        ? [nodeObj['row']]
        : [];

    for (const rawRow of rawRows) {
      const row: XctraceRow = {};
      const rowObj = rawRow as Record<string, unknown>;

      for (const [tag, value] of Object.entries(rowObj)) {
        if (tag.startsWith('@_')) continue;
        const resolved = resolveElement(value, refMap);
        if (resolved !== undefined) {
          row[tag] = resolved;
        }
      }
      rows.push(row);
    }
  }

  return rows;
}

function resolveElement(
  value: unknown,
  refMap: Map<string, string>,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  // Plain text or number (element with no attributes)
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value !== 'object') return undefined;

  const obj = value as Record<string, unknown>;

  // ref="N" → look up previously stored value
  const ref = obj['@_ref'];
  if (ref !== undefined) {
    const refKey = typeof ref === 'string' || typeof ref === 'number'
      ? String(ref)
      : undefined;
    return refKey !== undefined ? refMap.get(refKey) : undefined;
  }

  // Prefer text content; fall back to fmt for nested-child elements
  const text = obj['#text'];
  const fmt = obj['@_fmt'] as string | undefined;
  const display =
    text !== undefined && (typeof text === 'string' || typeof text === 'number')
      ? String(text)
      : fmt;

  // Store in refMap when element carries an id
  const id = obj['@_id'];
  if (id !== undefined && display !== undefined) {
    const idKey = typeof id === 'string' || typeof id === 'number'
      ? String(id)
      : undefined;
    if (idKey !== undefined) {
      refMap.set(idKey, display);
    }
  }

  return display;
}
