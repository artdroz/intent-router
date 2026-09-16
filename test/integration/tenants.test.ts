import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/store/db.js";
import { tenants } from "../../src/store/schema.js";
import { findOrCreateTenant } from "../../src/store/tenants.js";
import { resetDb, setupTestContext, teardownTestContext } from "../helpers/context.js";
import type { StubGateway } from "../helpers/gateway.js";

let gateway: StubGateway;

beforeAll(async () => {
  gateway = await setupTestContext();
});
afterAll(async () => {
  await teardownTestContext(gateway);
});
beforeEach(async () => {
  await resetDb();
});

describe("tenants (real database)", () => {
  it("creates a tenant and reuses it on the next call", async () => {
    const first = await findOrCreateTenant("auto-tenant");
    const second = await findOrCreateTenant("auto-tenant");

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);

    const rows = await getDb().select().from(tenants).where(eq(tenants.name, "auto-tenant"));
    expect(rows).toHaveLength(1);
  });

  it("is safe under concurrent creation", async () => {
    const [a, b] = await Promise.all([
      findOrCreateTenant("race-tenant"),
      findOrCreateTenant("race-tenant"),
    ]);

    expect(a?.id).toBe(b?.id);

    const rows = await getDb().select().from(tenants).where(eq(tenants.name, "race-tenant"));
    expect(rows).toHaveLength(1);
  });
});
