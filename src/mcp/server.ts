import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FastMCP } from "fastmcp";
import { resolveServiceTenant, serviceTokenMatches, type ServiceTokenConfig } from "../auth/service-token.js";
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

/** Build the in-process MCP server with its tools and LiteLLM service-token authentication. */
export function buildMcpServer(config: ServiceTokenConfig): FastMCP<McpSession> {
  const server = new FastMCP<McpSession>({
    name: "intent-router",
    version: packageVersion(),
    authenticate: async (request: IncomingMessage | undefined) => {
      // stdio has no HTTP request context, so fail closed: this server only
      // accepts the LiteLLM service token over HTTP transport.
      if (!request) return unauthorized();

      if (!serviceTokenMatches(request.headers, config.LITELLM_PROXY_TOKEN)) {
        return unauthorized();
      }

      const result = await resolveServiceTenant(request.headers, config);
      if (result.ok) return { tenantId: result.tenantId };

      // initialize / tools/list arrive without a tenant header (the guardrail
      // only stamps tool calls). Admit them with an empty session; tenant-bound
      // tools fail closed later via requireTenant.
      if (result.error === "missing_tenant") return {};

      return unauthorized();
    },
  });

  registerMcpTools(server);

  return server;
}
