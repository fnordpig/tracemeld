import { execFileSync } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';

export const KNOWN_SCHEMAS = [
  'metal-gpu-intervals',
  'metal-driver-event-intervals',
  'mps-hw-intervals',
  'os-signpost-interval',
] as const;

export type KnownSchema = (typeof KNOWN_SCHEMAS)[number];

export function parseToc(tocXml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'table' || name === 'run',
  });

  const doc = parser.parse(tocXml) as Record<string, unknown>;
  const toc = doc['trace-toc'] as Record<string, unknown> | undefined;
  if (!toc) return [];

  const runs: unknown[] = Array.isArray(toc['run']) ? toc['run'] : toc['run'] ? [toc['run']] : [];
  const schemas: string[] = [];

  for (const run of runs) {
    const runObj = run as Record<string, unknown>;
    const data = runObj['data'] as Record<string, unknown> | undefined;
    if (!data) continue;

    const tables: unknown[] = Array.isArray(data['table'])
      ? data['table']
      : data['table']
        ? [data['table']]
        : [];

    for (const table of tables) {
      const tableObj = table as Record<string, unknown>;
      const schema = tableObj['@_schema'] as string | undefined;
      if (schema) schemas.push(schema);
    }
  }

  return schemas;
}

export function discoverSchemas(tracePath: string): string[] {
  const stdout = runXctrace(['export', '--input', tracePath, '--toc']);
  return parseToc(stdout);
}

export function exportSchema(tracePath: string, schema: string): string {
  const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;
  return runXctrace(['export', '--input', tracePath, '--xpath', xpath]);
}

function runXctrace(args: string[]): string {
  try {
    const result = execFileSync('xcrun', ['xctrace', ...args], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
    return result;
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    if (error.code === 'ENOENT') {
      throw new Error(
        'xctrace not found. Requires macOS with Xcode Command Line Tools installed. ' +
          'Install with: xcode-select --install',
      );
    }
    throw new Error(`xctrace export failed: ${error.message ?? 'unknown error'}`);
  }
}
