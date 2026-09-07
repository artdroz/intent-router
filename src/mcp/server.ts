import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FastMCP } from "fastmcp";
import { verifyApiKey } from "../auth/api-keys.js";
import { registerMcpTools } from "./tools.js";
import type { McpSession } from "./session.js";

// Locate package.json relative to this module, independent of CWD. Works both
// from source (src/mcp/server.ts) and from the compiled build
// (dist/src/mcp/server.js): walk up until a package.json is found.
function findPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Could not locate package.json");
}

function packageVersion(): `${number}.${number}.${number}` {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(findPackageJson(here), "utf8")) as {
    version: `${number}.${number}.${number}`;
  };
  return pkg.version;
}

function unauthorized(): never {
  // FastMCP rejects a connection when `authenticate` throws a `Response`.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw new Response(null, { status: 401, statusText: "Unauthorized" });
}

/** Build the in-process MCP server with its tools and API-key authentication. */
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
