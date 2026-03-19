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
  return JSON.parse(content[0].text) as unknown;
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
});
