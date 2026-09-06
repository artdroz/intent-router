import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey, extendApiKey, verifyApiKey } from "./api-keys.js";
import * as store from "../store/api-keys.js";
import type { ApiKeyRow } from "../store/schema.js";

vi.mock("../store/api-keys.js", () => ({
  insertKey: vi.fn(),
  findKeyByHash: vi.fn(),
  findKeyByName: vi.fn(),
  listKeys: vi.fn(),
  updateKey: vi.fn(),
}));

const findKeyByHash = vi.mocked(store.findKeyByHash);
const findKeyByName = vi.mocked(store.findKeyByName);
const updateKey = vi.mocked(store.updateKey);

function keyRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 1,
    tenantId: "tenant-1",
    keyHash: "hash",
    prefix: "sk-abc123",
    name: "prod",
    enabled: 1,
    expiresAt: null,
    createdAt: new Date(),
    lastUsedAt: null,
    ...overrides,
  };
}

describe("verifyApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing or non-Bearer authorization header", async () => {
    expect(await verifyApiKey(undefined)).toEqual({ ok: false, error: "missing" });
    expect(await verifyApiKey("Basic abc")).toEqual({ ok: false, error: "missing" });
    expect(findKeyByHash).not.toHaveBeenCalled();
  });

  it("rejects an unknown key", async () => {
    findKeyByHash.mockResolvedValue(null as never);

    expect(await verifyApiKey("Bearer sk-unknown")).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects a disabled key", async () => {
    findKeyByHash.mockResolvedValue(keyRow({ enabled: 0 }));

    expect(await verifyApiKey("Bearer sk-x")).toEqual({ ok: false, error: "disabled" });
  });

  it("rejects an expired key", async () => {
    findKeyByHash.mockResolvedValue(keyRow({ expiresAt: new Date(Date.now() - 60_000) }));

    expect(await verifyApiKey("Bearer sk-x")).toEqual({ ok: false, error: "expired" });
  });

  it("accepts a valid key and returns the tenant id", async () => {
    findKeyByHash.mockResolvedValue(keyRow({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(await verifyApiKey("Bearer sk-x")).toEqual({ ok: true, tenantId: "tenant-1" });
  });

  it("accepts a key with no expiry", async () => {
    findKeyByHash.mockResolvedValue(keyRow({ expiresAt: null }));

    expect(await verifyApiKey("Bearer sk-x")).toEqual({ ok: true, tenantId: "tenant-1" });
  });
});

describe("extendApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends from the current expiry when the key is not yet expired", async () => {
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    findKeyByName.mockResolvedValue(keyRow({ expiresAt: new Date("2026-02-01T00:00:00Z") }));
    updateKey.mockResolvedValue(keyRow());

    await extendApiKey("tenant-1", "prod", 10);

    expect(updateKey).toHaveBeenCalledWith("tenant-1", "prod", {
      expiresAt: new Date("2026-02-11T00:00:00Z"),
    });
  });

  it("extends from now when the key is expired or has no expiry", async () => {
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    findKeyByName.mockResolvedValue(keyRow({ expiresAt: new Date("2025-12-01T00:00:00Z") }));
    updateKey.mockResolvedValue(keyRow());

    await extendApiKey("tenant-1", "prod", 5);

    expect(updateKey).toHaveBeenCalledWith("tenant-1", "prod", {
      expiresAt: new Date("2026-01-15T00:00:00Z"),
    });
  });
});

describe("createApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an out-of-range or non-integer expiry", async () => {
    findKeyByName.mockResolvedValue(null as never);

    await expect(
      createApiKey({ tenantId: "tenant-1", name: "prod", expiresInDays: 0 }),
    ).rejects.toThrow(/Days must be an integer between 1 and 365/);
    await expect(
      createApiKey({ tenantId: "tenant-1", name: "prod", expiresInDays: 366 }),
    ).rejects.toThrow(/Days must be an integer between 1 and 365/);
    await expect(
      createApiKey({ tenantId: "tenant-1", name: "prod", expiresInDays: 1.5 }),
    ).rejects.toThrow(/Days must be an integer between 1 and 365/);
  });
});
