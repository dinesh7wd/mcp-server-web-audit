import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logDebug } from '../logger.js';
import { auditAccessibilityTool } from './audit-accessibility.js';
import { auditFullTool } from './audit-full.js';
import { auditPerformanceTool } from './audit-performance.js';
import { auditSecurityTool } from './audit-security.js';
import { auditSeoTool } from './audit-seo.js';
import { auditTrackingTool } from './audit-tracking.js';
import { AUDIT_ANNOTATIONS, AuditTool } from './common.js';

/**
 * Registry of all available web audit tools.
 */
export const ALL_TOOLS: AuditTool[] = [
  auditSeoTool,
  auditSecurityTool,
  auditTrackingTool,
  auditAccessibilityTool,
  auditPerformanceTool,
  auditFullTool,
];

/**
 * Registers all MCP audit tools (with per-tool schemas and read-only annotations).
 * @param server McpServer instance
 */
export function registerTools(server: McpServer): void {
  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...AUDIT_ANNOTATIONS },
      },
      (args, extra) => tool.handler(args, extra),
    );
  }
  logDebug('Registered MCP web audit tools', { count: ALL_TOOLS.length });
}
