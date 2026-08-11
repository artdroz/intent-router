import * as store from "../store/gates.js";
import type { CreateGateInput, UpdateGateInput, UpdateClassInput, AddClassInput } from "./schema.js";
import type { Gate, GateClass } from "./types.js";
import type { GateRow, ClassRow } from "../store/schema.js";

export async function createGate(apiKeyId: number, input: CreateGateInput): Promise<Gate> {
  assertValidClasses(input.classes);
  await assertValidGateName(apiKeyId, input.name);

  const raw = await store.createGate(apiKeyId, input);
  if (!raw) throw new Error("Failed to create gate");
  // TODO: generate embeddings for utterances
  return toGate(raw);
}

export async function getGate(apiKeyId: number, name: string): Promise<Gate | null> {
  const raw = await store.getGateByName(apiKeyId, name);
  return raw ? toGate(raw) : null;
}

export async function listGates(apiKeyId: number): Promise<Gate[]> {
  const raws = await store.listGates(apiKeyId);
  return raws.map(toGate);
}

export async function updateGate(
  apiKeyId: number,
  name: string,
  input: UpdateGateInput,
): Promise<Gate> {
  if (input.name) await assertValidGateName(apiKeyId, input.name);
  const raw = await store.updateGate(apiKeyId, name, input);
  if (!raw) throw new Error(`Gate "${name}" not found`);
  return toGate(raw);
}

export async function updateClass(
  apiKeyId: number,
  gateName: string,
  label: string,
  input: UpdateClassInput,
): Promise<GateClass> {
  const existing = await store.getGateByName(apiKeyId, gateName);
  if (!existing) throw new Error(`Gate "${gateName}" not found`);

  const current = existing.classes.find((c) => c.label === label);
  if (!current) throw new Error(`Class "${label}" not found in gate "${gateName}"`);

  // Label rename must not collide
  if (input.label && input.label !== label) {
    if (existing.classes.some((c) => c.label === input.label)) {
      throw new Error(`Class "${input.label}" already exists in gate "${gateName}"`);
    }
  }
  // Utterances must not be wiped
  const mergedUtterances = input.utterances ?? current.utterances;
  if (mergedUtterances.length === 0) {
    throw new Error(`Class "${label}" must have at least one utterance`);
  }

  const raw = await store.updateClass(apiKeyId, gateName, label, input);
  if (!raw) throw new Error(`Gate "${gateName}" or class "${label}" not found`);
  return toGateClass(raw);
}

export async function disableGate(apiKeyId: number, name: string): Promise<void> {
  const disabled = await store.disableGate(apiKeyId, name);
  if (!disabled) throw new Error(`Gate "${name}" not found`);
}

export async function addClass(
  apiKeyId: number,
  gateName: string,
  input: AddClassInput,
): Promise<GateClass> {
  const existing = await store.getGateByName(apiKeyId, gateName);
  if (!existing) throw new Error(`Gate "${gateName}" not found`);

  assertValidClasses([...existing.classes.map(toGateClass), { label: input.label, utterances: input.utterances }]);

  const raw = await store.addClass(apiKeyId, gateName, input);
  if (!raw) throw new Error(`Failed to add class "${input.label}"`);
  // TODO: generate embeddings for new utterances
  return toGateClass(raw);
}

export async function deleteClass(
  apiKeyId: number,
  gateName: string,
  label: string,
): Promise<void> {
  const existing = await store.getGateByName(apiKeyId, gateName);
  if (!existing) throw new Error(`Gate "${gateName}" not found`);
  if (existing.classes.length <= 2) {
    throw new Error(`Gate "${gateName}" must have at least two classes`);
  }

  const result = await store.deleteClass(apiKeyId, gateName, label);
  if (!result) throw new Error(`Class "${label}" not found in gate "${gateName}"`);
}

function toGate(raw: { gate: GateRow; classes: ClassRow[] }): Gate {
  return {
    id: raw.gate.id,
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
    label: c.label,
    utterances: c.utterances,
    keywords: c.keywords,
    promotedKeywords: c.promotedKeywords,
  };
}

async function assertValidGateName(apiKeyId: number, name: string) {
  const exists = await store.gateNameExists(apiKeyId, name);
  if (exists) throw new Error(`Gate "${name}" already exists (or is disabled — names cannot be reused)`);
}

function assertValidClasses(classes: { label: string; utterances?: string[] | null }[]) {
  if (classes.length < 2) {
    throw new Error("Gate must have at least two classes");
  }
  if (classes.length > 50) {
    throw new Error("Gate cannot have more than 50 classes");
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
