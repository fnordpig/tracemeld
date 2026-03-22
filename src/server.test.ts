import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from './server.js';

interface TraceResult {
  span_id: string;
  depth: number;
  elapsed_ms?: number;
  parent_id?: string;
}

interface MarkResult {
  marker_id: string;
  timestamp: number;
}

let client: Client | undefined;
let server: McpServer | undefined;

async function createTestClient(): Promise<Client> {
  server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function parseToolResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  // Use last content block — tools with headlines put summary first, JSON last
  return JSON.parse(content[content.length - 1].text) as unknown;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
});

describe('MCP Server', () => {
  it('lists trace and mark tools', async () => {
    const c = await createTestClient();
    const result = await c.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('trace');
    expect(names).toContain('mark');
  });

  it('trace begin returns span_id', async () => {
    const c = await createTestClient();
    const result = await c.callTool({
      name: 'trace',
      arguments: { action: 'begin', kind: 'thinking', name: 'planning' },
    });
    const parsed = parseToolResult(result) as TraceResult;
    expect(parsed.span_id).toBeDefined();
    expect(parsed.depth).toBe(1);
  });

  it('trace end returns elapsed_ms', async () => {
    const c = await createTestClient();
    await c.callTool({
      name: 'trace',
      arguments: { action: 'begin', kind: 'bash' },
    });
    const result = await c.callTool({
      name: 'trace',
      arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } },
    });
    const parsed = parseToolResult(result) as TraceResult;
    expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.depth).toBe(0);
  });

  it('mark returns marker_id and timestamp', async () => {
    const c = await createTestClient();
    const result = await c.callTool({
      name: 'mark',
      arguments: { what: 'test checkpoint', severity: 'info' },
    });
    const parsed = parseToolResult(result) as MarkResult;
    expect(parsed.marker_id).toBeDefined();
    expect(parsed.timestamp).toBeGreaterThan(0);
  });

  it('profile_summary returns totals and groups', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });

    const result = await c.callTool({
      name: 'profile_summary',
      arguments: { group_by: 'kind' },
    });
    const parsed = parseToolResult(result) as { span_count: number; groups: Array<{ key: string }> };
    expect(parsed.span_count).toBeGreaterThan(0);
    expect(parsed.groups.length).toBeGreaterThan(0);
  });

  it('hotspots returns ranked entries', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });

    const result = await c.callTool({
      name: 'hotspots',
      arguments: { dimension: 'wall_ms', top_n: 5 },
    });
    const parsed = parseToolResult(result) as { entries: Array<{ name: string }> };
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('explain_span returns span details', async () => {
    const c = await createTestClient();
    const traceResult = await c.callTool({
      name: 'trace',
      arguments: { action: 'begin', kind: 'bash', name: 'npm test' },
    });
    const traceData = parseToolResult(traceResult) as { span_id: string };
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } } });

    const result = await c.callTool({
      name: 'explain_span',
      arguments: { span_id: traceData.span_id },
    });
    const parsed = parseToolResult(result) as { span: { name: string } };
    expect(parsed.span.name).toBe('bash:npm test');
  });

  it('find_waste returns waste items', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'turn', name: '1' } });
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 }, error: 'fail' } });
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'npm test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'turn' } });

    const result = await c.callTool({
      name: 'find_waste',
      arguments: {},
    });
    const parsed = parseToolResult(result) as { items: Array<{ pattern: string }>; total_savings: Record<string, number> };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.total_savings['wall_ms']).toBeGreaterThan(0);
  });

  it('import_profile imports collapsed stacks', async () => {
    const c = await createTestClient();
    const result = await c.callTool({
      name: 'import_profile',
      arguments: { source: 'main;foo;bar 10\nmain;foo;baz 20\n' },
    });
    const parsed = parseToolResult(result) as { format_detected: string; samples_added: number };
    expect(parsed.format_detected).toBe('collapsed');
    expect(parsed.samples_added).toBe(2);
  });

  it('export_profile exports collapsed stacks', async () => {
    const c = await createTestClient();
    await c.callTool({
      name: 'import_profile',
      arguments: { source: 'main;foo;bar 10\n' },
    });
    const result = await c.callTool({
      name: 'export_profile',
      arguments: { format: 'collapsed', dimension: 'weight' },
    });
    const parsed = parseToolResult(result) as { data: string; size_bytes: number };
    expect(parsed.data).toContain('main;foo;bar 10');
    expect(parsed.size_bytes).toBeGreaterThan(0);
  });

  it('hotpaths returns ranked paths', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
    const result = await c.callTool({ name: 'hotpaths', arguments: { dimension: 'wall_ms' } });
    const parsed = parseToolResult(result) as { paths: unknown[] };
    expect(parsed.paths.length).toBeGreaterThan(0);
  });

  it('bottleneck returns optimization targets', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 5000 } } });
    const result = await c.callTool({ name: 'bottleneck', arguments: { dimension: 'wall_ms' } });
    const parsed = parseToolResult(result) as { entries: unknown[] };
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('spinpaths detects low-output spans', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'sleep' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 30000 } } });
    const result = await c.callTool({ name: 'spinpaths', arguments: {} });
    const parsed = parseToolResult(result) as { entries: unknown[] };
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('starvations returns empty for single-lane', async () => {
    const c = await createTestClient();
    await c.callTool({ name: 'trace', arguments: { action: 'begin', kind: 'bash', name: 'test' } });
    await c.callTool({ name: 'trace', arguments: { action: 'end', kind: 'bash', cost: { wall_ms: 100 } } });
    const result = await c.callTool({ name: 'starvations', arguments: {} });
    const parsed = parseToolResult(result) as { entries: unknown[] };
    expect(parsed.entries).toHaveLength(0);
  });
});
