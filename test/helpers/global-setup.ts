import { startTestDatabase } from "./db.js";

/**
 * Runs once per integration/e2e project: starts a throwaway PostgreSQL
 * container and exposes its admin connection URI to the test files through
 * TEST_DATABASE_ADMIN_URL. Each test file then creates and migrates its own
 * database inside the container. The returned teardown stops the container
 * after the last test file finishes.
 */
export default async function setup() {
  const { container, adminUrl } = await startTestDatabase();
  process.env.TEST_DATABASE_ADMIN_URL = adminUrl;

  return async () => {
    await container.stop();
  };
}
