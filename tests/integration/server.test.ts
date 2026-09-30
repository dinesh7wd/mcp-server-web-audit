import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/server.js';

const EXPECTED = ['audit_seo', 'audit_security', 'audit_tracking', 'audit_accessibility', 'audit_performance', 'audit_full'];

describe('MCP server over an in-memory transport', () => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const server = createMcpServer();

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists all six tools with titles, annotations and distinct descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    expect(new Set(tools.map((t) => t.description)).size).toBe(6);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false });
      expect(tool.inputSchema.required).toEqual(['url']);
      const serialized = JSON.stringify(tool.inputSchema);
      expect(serialized).not.toContain('$ref');
      expect(serialized).toContain('Public http:// or https:// URL');
    }
  });

  it('returns isError for SSRF payloads including IPv4-mapped IPv6 (C1)', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::a9fe:a9fe]/']) {
      const result = (await client.callTool({ name: 'audit_security', arguments: { url } })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('SSRF_BLOCKED');
    }
  });

  it('rejects localhost and malformed arguments', async () => {
    const local = (await client.callTool({ name: 'audit_full', arguments: { url: 'http://localhost:3000/api', format: 'json' } })) as CallToolResult;
    expect(local.isError).toBe(true);
    expect((local.content[0] as { text: string }).text).toContain('localhost');

    const invalid = (await client.callTool({ name: 'audit_seo', arguments: { url: 12345 } })) as CallToolResult;
    expect(invalid.isError).toBe(true);

    const unknown = (await client.callTool({ name: 'nope', arguments: {} })) as CallToolResult;
    expect(unknown.isError).toBe(true);
  });
});
