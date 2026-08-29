import * as store from "../store/gates.js";
import * as embeddingsStore from "../store/embeddings.js";
import { getEmbedClient } from "../lib/embed-client.js";
import { GATE_MAX_CLASSES, GATE_MIN_CLASSES } from "./config.js";
import type {
  CreateGateInput,
  UpdateGateInput,
  UpdateClassInput,
  AddClassInput,
} from "./schema.js";
import type { Gate, GateClass } from "./types.js";
import type { GateRow, ClassRow } from "../store/schema.js";

export async function createGate(tenantId: string, input: CreateGateInput): Promise<Gate> {
  assertValidClasses(input.classes);
  await assertGateNameAvailable(input.name);

  const raw = await store.createGate(tenantId, input);
  if (!raw) throw new Error("Failed to create gate");

  for (const c of raw.classes) {
    await indexClassUtterances(c.id, raw.gate.name, c.label, c.utterances);
  }

  return toGate(raw);
}

export async function getGate(tenantId: string, name: string): Promise<Gate | null> {
  const raw = await store.getGateByName(name);
  if (!raw) return null;
  if (raw.gate.tenantId !== null && raw.gate.tenantId !== tenantId) return null;
  return toGate(raw);
}

export async function listGates(tenantId: string): Promise<Gate[]> {
  const raws = await store.getGatesByTenant(tenantId);
  return raws.map(toGate);
}

export async function updateGate(
  tenantId: string,
  name: string,
  input: UpdateGateInput,
): Promise<Gate> {
  await getOwnedGate(tenantId, name);
  if (input.name) await assertGateNameAvailable(input.name);
  const raw = await store.updateGate(name, input);
  if (!raw) throw new Error(`Gate "${name}" not found`);
  return toGate(raw);
}

export async function updateClass(
  tenantId: string,
  gateName: string,
  label: string,
  input: UpdateClassInput,
): Promise<GateClass> {
  const existing = await getOwnedGate(tenantId, gateName);

  const current = existing.classes.find((c) => c.label === label);
  if (!current) throw new Error(`Class "${label}" not found in gate "${gateName}"`);

  // Label rename must not collide
  if (input.label && input.label !== label) {
    if (existing.classes.some((c) => c.label === input.label)) {
      throw new Error(`Duplicate class label "${input.label}" in gate "${gateName}"`);
    }
  }
  // Utterances must not be wiped
  const mergedUtterances = input.utterances ?? current.utterances;
  if (mergedUtterances.length === 0) {
    throw new Error(`Class "${label}" must have at least one utterance`);
  }

  const raw = await store.updateClass(gateName, label, input);
  if (!raw) throw new Error(`Gate "${gateName}" or class "${label}" not found`);

  // Re-index if utterances changed: embed first (slow API, outside tx),
  // then atomically replace old config embeddings with new ones.
  if (input.utterances) {
    const rows = await buildEmbeddingRows(raw.id, gateName, raw.label, raw.utterances);
    await embeddingsStore.replaceClassEmbeddings(raw.id, "config", rows);
  }

  return toGateClass(raw);
}

export async function disableGate(tenantId: string, name: string): Promise<void> {
  await getOwnedGate(tenantId, name);
  const disabled = await store.disableGate(name);
  if (!disabled) throw new Error(`Gate "${name}" not found`);
}

export async function addClass(
  tenantId: string,
  gateName: string,
  input: AddClassInput,
): Promise<GateClass> {
  const existing = await getOwnedGate(tenantId, gateName);

  assertValidClasses([
    ...existing.classes.map(toGateClass),
    { label: input.label, utterances: input.utterances },
  ]);

  const raw = await store.addClass(gateName, input);
  if (!raw) throw new Error(`Failed to add class "${input.label}"`);

  await indexClassUtterances(raw.id, gateName, raw.label, raw.utterances);

  return toGateClass(raw);
}

export async function deleteClass(
  tenantId: string,
  gateName: string,
  label: string,
): Promise<void> {
  const existing = await getOwnedGate(tenantId, gateName);
  if (existing.classes.length <= GATE_MIN_CLASSES) {
    throw new Error(`Gate "${gateName}" must have at least ${GATE_MIN_CLASSES} classes`);
  }

  const result = await store.deleteClass(gateName, label);
  if (!result) throw new Error(`Class "${label}" not found in gate "${gateName}"`);
}

export function toGate(raw: { gate: GateRow; classes: ClassRow[] }): Gate {
  return {
    id: raw.gate.id,
    tenantId: raw.gate.tenantId,
    name: raw.gate.name,
    description: raw.gate.description,
    config: raw.gate.config as unknown as Gate["config"],
    classes: raw.classes.map(toGateClass),
    createdAt: raw.gate.createdAt,
    updatedAt: raw.gate.updatedAt,
  };
}

function toGateClass(c: ClassRow): GateClass {
  return {
    id: c.id,
    label: c.label,
    utterances: c.utterances,
    keywords: c.keywords,
  };
}

async function getOwnedGate(tenantId: string, name: string) {
  const raw = await store.getGateByName(name);
  if (!raw || raw.gate.tenantId !== tenantId) {
    throw new Error(`Gate "${name}" not found`);
  }
  return raw;
}

async function assertGateNameAvailable(name: string) {
  const exists = await store.gateNameExists(name);
  if (exists)
    throw new Error(`Gate "${name}" already exists (or is disabled — names cannot be reused)`);
}

export function assertValidClasses(classes: { label: string; utterances?: string[] | null }[]) {
  if (classes.length < GATE_MIN_CLASSES) {
    throw new Error(`Gate must have at least ${GATE_MIN_CLASSES} classes`);
  }
  if (classes.length > GATE_MAX_CLASSES) {
    throw new Error(`Gate cannot have more than ${GATE_MAX_CLASSES} classes`);
  }

  const seen = new Set<string>();
  for (const c of classes) {
    if (seen.has(c.label)) {
      throw new Error(`Duplicate class label "${c.label}"`);
    }
    if (!c.utterances || c.utterances.length === 0) {
      throw new Error(`Class "${c.label}" must have at least one utterance`);
    }
    seen.add(c.label);
  }
}

/** Embed utterances into NewEmbeddingInput rows (no DB write). */
export async function buildEmbeddingRows(
  classId: number,
  gateName: string,
  label: string,
  utterances: string[],
) {
  const embedClient = getEmbedClient();
  return Promise.all(
    utterances.map(async (text) => ({
      classId,
      gateName,
      label,
      content: text,
      source: "config" as const,
      embedding: await embedClient.embed(text),
    })),
  );
}

export async function indexClassUtterances(
  classId: number,
  gateName: string,
  label: string,
  utterances: string[],
) {
  if (utterances.length === 0) return;
  const rows = await buildEmbeddingRows(classId, gateName, label, utterances);
  await embeddingsStore.insertMany(rows);
}
