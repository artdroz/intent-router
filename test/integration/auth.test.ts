import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createApiKey,
  disableApiKey,
  enableApiKey,
  extendApiKey,
  listKeys,
  renameApiKey,
  verifyApiKey,
} from "../../src/auth/api-keys.js";
import { findKeyByName, updateKey } from "../../src/store/api-keys.js";
import { createTenant } from "../../src/store/tenants.js";
import type { TenantRow } from "../../src/store/schema.js";
import { resetDb, setupTestContext, teardownTestContext } from "../helpers/context.js";
import type { StubGateway } from "../helpers/gateway.js";

let gateway: StubGateway;
let tenant: TenantRow;

beforeAll(async () => {
  gateway = await setupTestContext();
});
afterAll(async () => {
  await teardownTestContext(gateway);
});
beforeEach(async () => {
  await resetDb();
  tenant = await createTenant("tenant-1");
});

describe("api keys (real database)", () => {
  it("creates a key and verifies it", async () => {
    const raw = await createApiKey({ tenantId: tenant.id, name: "prod" });
    expect(raw.startsWith("sk-")).toBe(true);

    expect(await verifyApiKey(`Bearer ${raw}`)).toEqual({ ok: true, tenantId: tenant.id });
  });

  it("rejects an unknown key", async () => {
    expect(await verifyApiKey("Bearer sk-wrong")).toEqual({ ok: false, error: "invalid" });
  });

  it("disables and re-enables a key", async () => {
    const raw = await createApiKey({ tenantId: tenant.id, name: "prod" });

    await disableApiKey(tenant.id, "prod");
    expect(await verifyApiKey(`Bearer ${raw}`)).toEqual({ ok: false, error: "disabled" });

    await enableApiKey(tenant.id, "prod");
    expect(await verifyApiKey(`Bearer ${raw}`)).toEqual({ ok: true, tenantId: tenant.id });
  });

  it("renames a key", async () => {
    await createApiKey({ tenantId: tenant.id, name: "old" });

    await renameApiKey(tenant.id, "old", "new");

    const keys = await listKeys(tenant.id);
    expect(keys.map((k) => k.name)).toEqual(["new"]);
  });

  it("extends an unexpired key from its current expiry", async () => {
    await createApiKey({ tenantId: tenant.id, name: "prod", expiresInDays: 10 });
    const before = await findKeyByName(tenant.id, "prod");
    expect(before!.expiresAt).not.toBeNull();

    await extendApiKey(tenant.id, "prod", 5);
    const after = await findKeyByName(tenant.id, "prod");

    const delta = after!.expiresAt!.getTime() - before!.expiresAt!.getTime();
    expect(Math.abs(delta - 5 * 86_400_000)).toBeLessThan(1000);
  });

  it("extends an expired key from the current date", async () => {
    await createApiKey({ tenantId: tenant.id, name: "prod", expiresInDays: 1 });
    await updateKey(tenant.id, "prod", { expiresAt: new Date(Date.now() - 86_400_000) });

    const before = Date.now();
    await extendApiKey(tenant.id, "prod", 5);
    const after = await findKeyByName(tenant.id, "prod");

    expect(after!.expiresAt!.getTime()).toBeGreaterThan(before);
    const delta = after!.expiresAt!.getTime() - before;
    expect(Math.abs(delta - 5 * 86_400_000)).toBeLessThan(60_000);
  });

  it("rejects a duplicate key name", async () => {
    await createApiKey({ tenantId: tenant.id, name: "prod" });

    await expect(createApiKey({ tenantId: tenant.id, name: "prod" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("lists no keys for a fresh tenant", async () => {
    expect(await listKeys(tenant.id)).toEqual([]);
  });
});
