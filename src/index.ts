import { buildApp } from "./app.js";
import { buildMcpServer } from "./mcp/server.js";

const app = await buildApp();

// In-process MCP server (HTTP transport). Shares the same DB/LLM/embed
// clients and the same API-key auth as the REST surface.
const mcp = buildMcpServer();
await mcp.start({
  transportType: "httpStream",
  httpStream: { host: "0.0.0.0", port: app.config.MCP_PORT },
});
app.log.info(`MCP server listening on :${app.config.MCP_PORT}/mcp`);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await mcp.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: app.config.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
