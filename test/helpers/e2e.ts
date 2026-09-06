import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
  connectDb,
  createDatabase,
  disconnectDb,
  dropDatabase,
  migrate,
  uniqueDatabaseName,
  urlForDatabase,
} from "./db.js";
import { startGateway, GATEWAY_DIMS, type StubGateway } from "./gateway.js";

export type RunningApp = {
  app: FastifyInstance;
  baseUrl: string;
  gateway: StubGateway;
  token: string;
};

export const E2E_TOKEN = "test-proxy-token";
export const E2E_TENANT_NAME = "tenant-e2e";

let adminUrl: string;
let dbName: string;

/**
 * Boot the real application composition (`buildApp`) against a per-file
 * database and the local stub gateway, bound to an OS-assigned port. The
 * environment variables are set before `buildApp` runs so `@fastify/env`
 * picks them up in preference to any checked-in `.env` file.
 */
export async function bootTestApp(): Promise<RunningApp> {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_ADMIN_URL is not set — run via the e2e project");
  }
  adminUrl = url;

  dbName = uniqueDatabaseName("e2e");
  await createDatabase(adminUrl, dbName);
  const dbUrl = urlForDatabase(adminUrl, dbName);
  connectDb(dbUrl); // lets helpers use getDb() for resetE2eData and runs migrations
  await migrate();

  const gateway = await startGateway();

  process.env.DATABASE_URL = dbUrl;
  process.env.EMBED_BASE_URL = gateway.url;
  process.env.EMBED_MODEL = "test-model";
  process.env.EMBED_DIMS = String(GATEWAY_DIMS);
  process.env.LLM_BASE_URL = gateway.url;
  process.env.LLM_MODEL = "test-model";
  process.env.LITELLM_PROXY_TOKEN = E2E_TOKEN;
  process.env.DEFAULT_GATES_CONFIG_PATH = fileURLToPath(
    new URL("../fixtures/default-gates.yaml", import.meta.url),
  );

  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { address: string; port: number };

  return { app, baseUrl: `http://127.0.0.1:${address.port}`, gateway, token: E2E_TOKEN };
}

export async function stopTestApp(running: RunningApp): Promise<void> {
  await running.app.close();
  await running.gateway.server.close();
  await disconnectDb();
  await dropDatabase(adminUrl, dbName);
}
