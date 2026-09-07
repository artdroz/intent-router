import { initEmbedClient } from "../../src/clients/embed-client.js";
import { initLlmClient } from "../../src/clients/llm-client.js";
import { initRouter } from "../../src/routing/service.js";
import {
  connectDb,
  createDatabase,
  disconnectDb,
  dropDatabase,
  migrate,
  resetDb,
  resetE2eData,
  uniqueDatabaseName,
  urlForDatabase,
} from "./db.js";
import { startGateway, GATEWAY_DIMS, type StubGateway } from "./gateway.js";

let adminUrl: string;
let dbName: string;
let currentDbUrl: string;

/**
 * Wire up the service singletons against a per-file database and the local
 * stub gateway. Every integration test file calls this in `beforeAll`; the
 * matching teardown closes the gateway, drops the database, and closes the
 * pool in `afterAll`.
 */
export async function setupTestContext(): Promise<StubGateway> {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_ADMIN_URL is not set — run via the integration or e2e project");
  }
  adminUrl = url;

  dbName = uniqueDatabaseName("it");
  await createDatabase(adminUrl, dbName);
  currentDbUrl = urlForDatabase(adminUrl, dbName);
  connectDb(currentDbUrl);
  await migrate();

  const gateway = await startGateway();

  const embed = initEmbedClient({ baseUrl: gateway.url, model: "test-model", dims: GATEWAY_DIMS });
  const llm = initLlmClient({ baseUrl: gateway.url, model: "test-model" });
  initRouter(llm, embed, 50_000);

  return gateway;
}

export async function teardownTestContext(gateway: StubGateway): Promise<void> {
  await gateway.server.close();
  await disconnectDb();
  await dropDatabase(adminUrl, dbName);
}

/** Connection URL of the current test file's database (for code that opens its own client). */
export function getTestDbUrl(): string {
  return currentDbUrl;
}

export { resetDb, resetE2eData };
