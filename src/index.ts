#!/usr/bin/env node
import { CONFIG } from './config.js';
import { logError, logInfo } from './logger.js';

async function main(): Promise<void> {
  if (CONFIG.transport === 'http') {
    const { startHttpServer } = await import('./httpServer.js');
    const server = await startHttpServer();
    const shutdown = (signal: string) => {
      logInfo(`Received ${signal}, closing HTTP server...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }
  const { createServer } = await import('./server.js');
  await createServer();
}

main().catch((err: unknown) => {
  logError('Fatal error bootstrapping MCP server', { error: String(err) });
  process.exit(1);
});
