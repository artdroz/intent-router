import { createHash, randomUUID } from "node:crypto";
import * as store from "../store/api-keys.js";
import * as gateStore from "../store/gates.js";



const MIN_NAME_LENGTH = 2;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 365;
export type ApiKeyError = "missing" | "invalid" | "disabled" | "expired";

export type ApiKeyResult = { ok: true; tenantId: string } | { ok: false; error: ApiKeyError };

/**
 * Resolve an `Authorization: Bearer <key>` header to a tenant principal.
 * Shared by the Fastify auth hook and the MCP authenticate callback.
 */
export async function verifyApiKey(authorization: string | undefined): Promise<ApiKeyResult> {
  if (!authorization?.startsWith("Bearer ")) {
    return { ok: false, error: "missing" };
  }

  const key = authorization.slice("Bearer ".length);
  const hash = createHash("sha256").update(key).digest("hex");
  const row = await store.findKeyByHash(hash);

  if (!row) return { ok: false, error: "invalid" };
  if (!row.enabled) return { ok: false, error: "disabled" };
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    return { ok: false, error: "expired" };
  }

  return { ok: true, tenantId: row.tenantId };
}

export async function createApiKey(opts: {
  tenantId: string;
  name: string;
  expiresInDays?: number;
}) {
  await assertValidName(opts.tenantId, opts.name);
  if (opts.expiresInDays !== undefined) assertValidExpiryDays(opts.expiresInDays);

  let raw: string;
  let hash: string;

  // Hash generation retry
  do {
    raw = `sk-${randomUUID()}`;
    hash = createHash("sha256").update(raw).digest("hex");
  } while (await store.findKeyByHash(hash));

  await store.insertKey({
    tenantId: opts.tenantId,
    keyHash: hash,
    prefix: raw.slice(0, 8),
    name: opts.name,
    expiresAt: opts.expiresInDays ? daysFromNow(opts.expiresInDays) : null,
  });

  return raw;
}

export async function renameApiKey(tenantId: string, oldName: string, newName: string) {
  await assertValidName(tenantId, newName);
  const key = await store.updateKey(tenantId, oldName, { name: newName });
  if (!key) throw new Error(`Key "${oldName}" not found`);
  return key;
}

export async function disableApiKey(tenantId: string, name: string) {
  const key = await store.updateKey(tenantId, name, { enabled: 0 });
  if (!key) throw new Error(`Key "${name}" not found`);
  return key;
}

export async function enableApiKey(tenantId: string, name: string) {
  const key = await store.updateKey(tenantId, name, { enabled: 1 });
  if (!key) throw new Error(`Key "${name}" not found`);
  return key;
}

/** Extend the expiry of an API key.
 *  If not expired, extend from the current expiry date.
 *  If expired, extend from the current date.
 */
export async function extendApiKey(tenantId: string, name: string, days: number) {
  assertValidExpiryDays(days);
  const key = await store.findKeyByName(tenantId, name);
  if (!key) throw new Error(`Key "${name}" not found`);

  const base =
    key.expiresAt && new Date(key.expiresAt) > new Date() ? new Date(key.expiresAt) : new Date();

  return store.updateKey(tenantId, name, {
    expiresAt: new Date(base.getTime() + days * 86_400_000),
  });
}

/** Transfer all gates from one tenant to another. */
export async function transferGates(fromTenantId: string, toTenantId: string) {
  // RoutingEvents is the audit trail, which stays with the original tenant.
  await gateStore.transferGates(fromTenantId, toTenantId);
}

export const listKeys = (tenantId: string) => store.listKeys(tenantId);

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function assertValidName(tenantId: string, name: string) {
  if (!name || name.length < MIN_NAME_LENGTH) {
    throw new Error(`Key name must be at least ${MIN_NAME_LENGTH} characters`);
  }
  const existing = await store.findKeyByName(tenantId, name);
  if (existing) {
    throw new Error(`Key "${name}" already exists`);
  }
}

function assertValidExpiryDays(days: number) {
  if (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
    throw new Error(`Days must be an integer between ${MIN_EXPIRY_DAYS} and ${MAX_EXPIRY_DAYS}`);
  }
}
