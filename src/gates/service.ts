import * as store from "../store/gates.js";
import type { CreateGateInput, UpdateGateInput } from "./schema.js";
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
  if (input.classes) assertValidClasses(input.classes);
  // TODO: regenerate embeddings for updated utterances
  return toGate(raw);
}

export async function disableGate(apiKeyId: number, name: string): Promise<void> {
  const disabled = await store.disableGate(apiKeyId, name);
  if (!disabled) throw new Error(`Gate "${name}" not found`);
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
  const existing = await store.getGateByName(apiKeyId, name);
  if (existing) throw new Error(`Gate "${name}" already exists`);
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
