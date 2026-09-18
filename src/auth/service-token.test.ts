import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { resolveServiceTenant, serviceTokenMatches } from "./service-token.js";
import * as tenants from "../store/tenants.js";

vi.mock("../store/tenants.js", () => ({
  findOrCreateTenant: vi.fn(),
  findTenantByName: vi.fn(),
}));

const findOrCreateTenant = vi.mocked(tenants.findOrCreateTenant);
const findTenantByName = vi.mocked(tenants.findTenantByName);

const config = { LITELLM_PROXY_TOKEN: "secret", AUTO_CREATE_TENANT: false };

function headers(
  overrides: Record<string, string | string[] | undefined> = {},
): IncomingHttpHeaders {
  return {
    "intent-router-token": "secret",
    "intent-router-tenant": "tenant-a",
    ...overrides,
  };
}

function tenantRow(id: string, name: string) {
  return { id, name, createdAt: new Date() };
}

describe("serviceTokenMatches", () => {
  it("matches the configured token", () => {
    expect(serviceTokenMatches(headers(), "secret")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(serviceTokenMatches(headers({ "intent-router-token": "wrong" }), "secret")).toBe(false);
  });
});

describe("resolveServiceTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a known tenant by name", async () => {
    findTenantByName.mockResolvedValue(tenantRow("tenant-id-1", "tenant-a"));

    expect(await resolveServiceTenant(headers(), config)).toEqual({
      ok: true,
      tenantId: "tenant-id-1",
    });
  });

  it("returns missing_tenant when the header is absent", async () => {
    const withoutTenant = headers();
    delete withoutTenant["intent-router-tenant"];

    expect(await resolveServiceTenant(withoutTenant, config)).toEqual({
      ok: false,
      error: "missing_tenant",
    });
    expect(findTenantByName).not.toHaveBeenCalled();
  });

  it("returns unknown_tenant for an unknown name", async () => {
    findTenantByName.mockResolvedValue(null as never);

    expect(
      await resolveServiceTenant(headers({ "intent-router-tenant": "ghost" }), config),
    ).toEqual({ ok: false, error: "unknown_tenant", tenantName: "ghost" });
  });

  it("auto-creates when AUTO_CREATE_TENANT is enabled", async () => {
    findOrCreateTenant.mockResolvedValue(tenantRow("new-id", "tenant-a"));

    const result = await resolveServiceTenant(headers(), {
      ...config,
      AUTO_CREATE_TENANT: true,
    });

    expect(findOrCreateTenant).toHaveBeenCalledWith("tenant-a");
    expect(result).toEqual({ ok: true, tenantId: "new-id" });
  });
});
