import { createHash, randomUUID } from "node:crypto";
import * as store from "../store/api-keys.js";

const MIN_NAME_LENGTH = 2;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 365;

export async function createApiKey(opts: { name: string; expiresInDays?: number }) {
  await assertValidName(opts.name);
  if (opts.expiresInDays !== undefined) assertValidExpiryDays(opts.expiresInDays);

  let raw: string;
  let hash: string;
  
  do {
    raw = `sk-${randomUUID()}`;
    hash = createHash("sha256").update(raw).digest("hex");
  } while (await store.findKeyByHash(hash));

  await store.insertKey({
    keyHash: hash,
    prefix: raw.slice(0, 8),
    name: opts.name,
    expiresAt: opts.expiresInDays ? daysFromNow(opts.expiresInDays) : null,
  });

  return raw;
}

export async function renameApiKey(oldName: string, newName: string) {
  await assertValidName(newName);
  const key = await store.updateKey(oldName, { name: newName });
  if (!key) throw new Error(`Key "${oldName}" not found`);
  return key;
}

export async function disableApiKey(name: string) {
  const key = await store.updateKey(name, { enabled: 0 });
  if (!key) throw new Error(`Key "${name}" not found`);
  return key;
}

export async function enableApiKey(name: string) {
  const key = await store.updateKey(name, { enabled: 1 });
  if (!key) throw new Error(`Key "${name}" not found`);
  return key;
}

export async function extendApiKey(name: string, days: number) {
  assertValidExpiryDays(days);
  const key = await store.findKeyByName(name);
  if (!key) throw new Error(`Key "${name}" not found`);

  const base = key.expiresAt && new Date(key.expiresAt) > new Date()
    ? new Date(key.expiresAt)
    : new Date();

  return store.updateKey(name, { expiresAt: new Date(base.getTime() + days * 86_400_000) });
}

export async function transferKey(fromName: string, toName: string) {
  const from = await store.findKeyByName(fromName);
  const to = await store.findKeyByName(toName);
  if (!from) throw new Error(`Key "${fromName}" not found`);
  if (!to) throw new Error(`Key "${toName}" not found`);

  // RoutingEvents stay with the original key
  await store.transferGates(from.id, to.id);
  await store.updateKey(fromName, { enabled: 0 });
}

export const listKeys = store.listKeys;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function assertValidName(name: string) {
  if (!name || name.length < MIN_NAME_LENGTH) {
    throw new Error(`Key name must be at least ${MIN_NAME_LENGTH} characters`);
  }
  const existing = await store.findKeyByName(name);
  if (existing) {
    throw new Error(`Key "${name}" already exists`);
  }
}

function assertValidExpiryDays(days: number) {
  if (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
    throw new Error(`Days must be an integer between ${MIN_EXPIRY_DAYS} and ${MAX_EXPIRY_DAYS}`);
  }
}
