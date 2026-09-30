import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONFIG } from './config.js';
import { logError, logInfo } from './logger.js';
import { registerTools } from './tools/index.js';

/**
 * Builds an MCP server with tools registered (no transport connected yet).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: CONFIG.server.name,
      version: CONFIG.server.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(server);

  server.server.onerror = (error) => {
    logError('MCP Server error occurred', { error: String(error) });
  };

  return server;
}

/**
 * Creates and starts the MCP server using stdio transport (Cursor local).
 */
export async function createServer(): Promise<McpServer> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logInfo('mcp-server-web-audit initialized and listening on stdio', {
    version: CONFIG.server.version,
  });

  const handleShutdown = async (signal: string) => {
    logInfo(`Received ${signal}, shutting down server gracefully...`);
    try {
      await server.close();
    } catch (err) {
      logError('Error during server shutdown', { error: String(err) });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

  return server;
}
