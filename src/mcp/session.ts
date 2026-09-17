/**
 * What an authenticated MCP session carries.
 *
 * FastMCP constrains its session type to `Record<string, unknown> | undefined`,
 * so we extend `Record<string, unknown>` to satisfy that bound.
 */
export interface McpSession extends Record<string, unknown> {
  tenantId?: string;
}
