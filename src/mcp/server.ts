import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { FastMCP } from "fastmcp";
import { verifyApiKey } from "../auth/api-keys.js";
import { registerMcpTools } from "./tools.js";
import type { McpSession } from "./session.js";

function packageVersion(): `${number}.${number}.${number}` {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: `${number}.${number}.${number}`;
  };
  return pkg.version;
}

function unauthorized(): never {
  // FastMCP rejects a connection when `authenticate` throws a `Response`.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw new Response(null, { status: 401, statusText: "Unauthorized" });
}

export function buildMcpServer(): FastMCP<McpSession> {
  const server = new FastMCP<McpSession>({
    name: "intent-router",
    version: packageVersion(),
    authenticate: async (request: IncomingMessage | undefined) => {
      // stdio has no HTTP request context, so fail closed: this server only
      // accepts API keys over HTTP transport.
      if (!request) return unauthorized();

      const result = await verifyApiKey(request.headers.authorization);
      if (!result.ok) return unauthorized();

      return { tenantId: result.tenantId };
    },
  });

  registerMcpTools(server);

  return server;
}
