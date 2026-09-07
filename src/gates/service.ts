import * as store from "../store/gates.js";
import * as embeddingsStore from "../store/embeddings.js";
import { getEmbedClient } from "../clients/embed-client.js";
import { GATE_MAX_CLASSES, GATE_MIN_CLASSES } from "./schema.js";
import type {
  CreateGateInput,
  UpdateGateInput,
  UpdateClassInput,
  AddClassInput,
} from "./schema.js";
import type { Gate, GateClass, GateDto, GateClassDto } from "./types.js";
import type { GateRow, ClassRow } from "../store/schema.js";
import { ConflictError, ForbiddenError, InternalError, NotFoundError, ValidationError } from "../errors.js";

/** Create a gate, its classes, and index their utterance embeddings. */
export async function createGate(tenantId: string, input: CreateGateInput): Promise<GateDto> {
  assertValidClasses(input.classes);
  await assertGateNameAvailable(input.name);

  const raw = await store.createGate(tenantId, input);
  if (!raw) throw new InternalError("Failed to create gate");

  for (const c of raw.classes) {
    await indexClassUtterances(c.id, raw.gate.name, c.label, c.utterances);
  }

  return toGateDto(toGate(raw));
}

/** Fetch a gate by name if it is visible to the tenant. */
export async function getGate(tenantId: string, name: string): Promise<GateDto | null> {
  const raw = await store.getGateByName(name);
  if (!raw) return null;
  if (raw.gate.tenantId !== null && raw.gate.tenantId !== tenantId) return null;
  return toGateDto(toGate(raw));
}

/** List the tenant's own gates plus the shared system gates. */
export async function listGates(tenantId: string): Promise<GateDto[]> {
  const raws = await store.getGatesByTenant(tenantId);
  return raws.map((raw) => toGateDto(toGate(raw)));
}

/** Rename a gate or update its description/config. */
export async function updateGate(
  tenantId: string,
  name: string,
  input: UpdateGateInput,
): Promise<GateDto> {
  await getOwnedGate(tenantId, name);
  if (input.name) await assertGateNameAvailable(input.name);
  const raw = await store.updateGate(name, input);
  if (!raw) throw new NotFoundError(`Gate "${name}" not found`);
  return toGateDto(toGate(raw));
}

/** Update a class's label, description, utterances, or keywords, re-indexing on utterance change. */
export async function updateClass(
  tenantId: string,
  gateName: string,
  label: string,
  input: UpdateClassInput,
): Promise<GateClassDto> {
  const existing = await getOwnedGate(tenantId, gateName);

  const current = existing.classes.find((c) => c.label === label);
  if (!current) throw new NotFoundError(`Class "${label}" not found in gate "${gateName}"`);

  // Label rename must not collide
  if (input.label && input.label !== label) {
    if (existing.classes.some((c) => c.label === input.label)) {
      throw new ConflictError(`Duplicate class label "${input.label}" in gate "${gateName}"`);
    }
  }
  // Utterances must not be wiped
  const mergedUtterances = input.utterances ?? current.utterances;
  if (mergedUtterances.length === 0) {
    throw new ValidationError(`Class "${label}" must have at least one utterance`);
  }

  const raw = await store.updateClass(gateName, label, input);
  if (!raw) throw new NotFoundError(`Gate "${gateName}" or class "${label}" not found`);

  // Re-index if utterances changed: embed first (slow API, outside tx),
  // then atomically replace old config embeddings with new ones.
  if (input.utterances) {
    const rows = await buildEmbeddingRows(raw.id, gateName, raw.label, raw.utterances);
    await embeddingsStore.replaceClassEmbeddings(raw.id, "config", rows);
  }

  return toGateClassDto(toGateClass(raw));
}

/** Soft-disable a gate without deleting its routing history. */
export async function disableGate(tenantId: string, name: string): Promise<void> {
  await getOwnedGate(tenantId, name);
  const disabled = await store.disableGate(name);
  if (!disabled) throw new NotFoundError(`Gate "${name}" not found`);
}

/** Add a class to a gate and index its utterances. */
export async function addClass(
  tenantId: string,
  gateName: string,
  input: AddClassInput,
): Promise<GateClassDto> {
  const existing = await getOwnedGate(tenantId, gateName);

  assertValidClasses([
    ...existing.classes.map(toGateClass),
    { label: input.label, utterances: input.utterances },
  ]);

  const raw = await store.addClass(gateName, input);
  if (!raw) throw new InternalError(`Failed to add class "${input.label}"`);

  await indexClassUtterances(raw.id, gateName, raw.label, raw.utterances);

  return toGateClassDto(toGateClass(raw));
}

/** Delete a class, guarding the minimum-class-count invariant. */
export async function deleteClass(
  tenantId: string,
  gateName: string,
  label: string,
): Promise<void> {
  const existing = await getOwnedGate(tenantId, gateName);
  if (existing.classes.length <= GATE_MIN_CLASSES) {
    throw new ConflictError(`Gate "${gateName}" must have at least ${GATE_MIN_CLASSES} classes`);
  }

  const result = await store.deleteClass(gateName, label);
  if (!result) throw new NotFoundError(`Class "${label}" not found in gate "${gateName}"`);
}

/** Map a stored gate row plus its class rows into the domain `Gate` shape. */
export function toGate(raw: { gate: GateRow; classes: ClassRow[] }): Gate {
  return {
    id: raw.gate.id,
    tenantId: raw.gate.tenantId,
    name: raw.gate.name,
    description: raw.gate.description,
    config: raw.gate.config as Gate["config"],
    classes: raw.classes.map(toGateClass),
    createdAt: raw.gate.createdAt,
    updatedAt: raw.gate.updatedAt,
  };
}

function toGateClass(c: ClassRow): GateClass {
  return {
    id: c.id,
    label: c.label,
    description: c.description ?? undefined,
    utterances: c.utterances,
    keywords: c.keywords,
  };
}

/** Map the domain `Gate` into its public API shape, dropping database keys. */
function toGateDto(gate: Gate): GateDto {
  return {
    name: gate.name,
    description: gate.description,
    shared: gate.tenantId === null,
    config: gate.config,
    classes: gate.classes.map(toGateClassDto),
    createdAt: gate.createdAt,
    updatedAt: gate.updatedAt,
  };
}

/** Map the domain `GateClass` into its public API shape, dropping the database key. */
function toGateClassDto(cls: GateClass): GateClassDto {
  return {
    label: cls.label,
    description: cls.description,
    utterances: cls.utterances,
    keywords: cls.keywords,
  };
}

async function getOwnedGate(tenantId: string, name: string) {
  const raw = await store.getGateByName(name);
  if (!raw || raw.gate.tenantId !== tenantId) {
    if (raw?.gate.tenantId === null) {
      throw new ForbiddenError(`System gate "${name}" is read-only`);
    }
    throw new NotFoundError(`Gate "${name}" not found`);
  }
  return raw;
}

async function assertGateNameAvailable(name: string) {
  const exists = await store.gateNameExists(name);
  if (exists)
    throw new ConflictError(
      `Gate "${name}" already exists (or is disabled — names cannot be reused)`,
    );
}

/** Validate the class-count, label-uniqueness, and utterance invariants shared by gate writes. */
export function assertValidClasses(classes: { label: string; utterances?: string[] | null }[]) {
  if (classes.length < GATE_MIN_CLASSES) {
    throw new ValidationError(`Gate must have at least ${GATE_MIN_CLASSES} classes`);
  }
  if (classes.length > GATE_MAX_CLASSES) {
    throw new ValidationError(`Gate cannot have more than ${GATE_MAX_CLASSES} classes`);
  }

  const seen = new Set<string>();
  for (const c of classes) {
    if (seen.has(c.label)) {
      throw new ConflictError(`Duplicate class label "${c.label}"`);
    }
    if (!c.utterances || c.utterances.length === 0) {
      throw new ValidationError(`Class "${c.label}" must have at least one utterance`);
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

/** Embed a class's utterances and insert them as config embeddings. */
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
