import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import { gates as gatesTable, classes as classesTable, embeddings as embeddingsTable } from "./schema.js";
import type { CreateGateInput, UpdateGateInput, UpdateClassInput, AddClassInput } from "../gates/schema.js";

export async function createGate(apiKeyId: number, input: CreateGateInput) {
  const db = getDb();

  const [gate] = await db
    .insert(gatesTable)
    .values({
      apiKeyId,
      name: input.name,
      description: input.description ?? null,
      config: input.config,
    })
    .returning();

  if (input.classes.length > 0) {
    await db.insert(classesTable).values(
      input.classes.map((c) => ({
        gateId: gate.id,
        gateName: gate.name,
        label: c.label,
        utterances: c.utterances,
        keywords: c.keywords ?? [],
      })),
    );
  }

  return getGateById(gate.id);
}

export async function getGateByName(apiKeyId: number, name: string) {
  const db = getDb();
  const [gate] = await db
    .select()
    .from(gatesTable)
    .where(and(
      eq(gatesTable.apiKeyId, apiKeyId),
      eq(gatesTable.name, name),
      eq(gatesTable.enabled, 1),
    ));

  if (!gate) return null;

  const gateClasses = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.gateId, gate.id));

  return { gate, classes: gateClasses };
}

export async function getGateById(id: number) {
  const db = getDb();
  const [gate] = await db.select().from(gatesTable).where(eq(gatesTable.id, id));
  if (!gate) return null;

  const gateClasses = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.gateId, gate.id));

  return { gate, classes: gateClasses };
}

export async function getClassById(id: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, id));
  return row ?? null;
}

/** Check if a gate name is taken (both enabled or disabled). */
export async function gateNameExists(apiKeyId: number, name: string) {
  const db = getDb();
  const [row] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(and(
      eq(gatesTable.apiKeyId, apiKeyId),
      eq(gatesTable.name, name),
    ));
  return !!row;
}

export async function listGates(apiKeyId: number) {
  const db = getDb();
  const gateRows = await db
    .select()
    .from(gatesTable)
    .where(and(eq(gatesTable.apiKeyId, apiKeyId), eq(gatesTable.enabled, 1)))
    .orderBy(gatesTable.createdAt);

  if (gateRows.length === 0) return [];

  const gateIds = gateRows.map((g) => g.id);
  const allClasses = await db
    .select()
    .from(classesTable)
    .where(inArray(classesTable.gateId, gateIds));

  const classesByGate = new Map<number, typeof allClasses>();
  for (const c of allClasses) {
    const list = classesByGate.get(c.gateId) ?? [];
    list.push(c);
    classesByGate.set(c.gateId, list);
  }

  return gateRows.map((gate) => ({
    gate,
    classes: classesByGate.get(gate.id) ?? [],
  }));
}

export async function updateGate(
  apiKeyId: number,
  name: string,
  input: UpdateGateInput,
) {
  const db = getDb();
  const existing = await getGateByName(apiKeyId, name);
  if (!existing) return null;
  const existingGate = existing.gate;

  if (input.name) {
    // Update gateName in denormalized tables (classes and embeddings)
    await db
      .update(classesTable)
      .set({ gateName: input.name })
      .where(eq(classesTable.gateId, existingGate.id));

    const toUpdate = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(eq(classesTable.gateId, existingGate.id));
    const ids = toUpdate.map((c) => c.id);

    if (ids.length > 0) {
      await db
        .update(embeddingsTable)
        .set({ gateName: input.name })
        .where(inArray(embeddingsTable.classId, ids));
    }
  }

  if (input.name || input.description !== undefined || input.config) {
    await db
      .update(gatesTable)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.config ? { config: input.config } : {}),
        updatedAt: new Date(),
      })
      .where(eq(gatesTable.id, existingGate.id));
  }

  return getGateByName(apiKeyId, input.name ?? name);
}

export async function updateClass(
  apiKeyId: number,
  gateName: string,
  label: string,
  input: UpdateClassInput,
) {
  const db = getDb();
  const gate = await getGateByName(apiKeyId, gateName);
  if (!gate) return null;

  const [c] = await db
    .select()
    .from(classesTable)
    .where(and(
      eq(classesTable.gateId, gate.gate.id),
      eq(classesTable.label, label),
    ));
  if (!c) return null;

  await db
    .update(classesTable)
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.utterances !== undefined ? { utterances: input.utterances } : {}),
      ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .where(eq(classesTable.id, c.id));

  if (input.label && input.label !== label) {
    await db
      .update(embeddingsTable)
      .set({ label: input.label })
      .where(eq(embeddingsTable.classId, c.id));
  }

  // Re-fetch updated row
  const [updated] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, c.id));
  return updated;
}

export async function addClass(
  apiKeyId: number,
  gateName: string,
  input: AddClassInput,
) {
  const db = getDb();
  const gate = await getGateByName(apiKeyId, gateName);
  if (!gate) return null;

  const [inserted] = await db.insert(classesTable).values({
    gateId: gate.gate.id,
    gateName,
    label: input.label,
    utterances: input.utterances,
    keywords: input.keywords ?? [],
  }).returning();

  return inserted;
}

export async function deleteClass(
  apiKeyId: number,
  gateName: string,
  label: string,
) {
  const db = getDb();
  const gate = await getGateByName(apiKeyId, gateName);
  if (!gate) return null;

  const [c] = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(and(
      eq(classesTable.gateId, gate.gate.id),
      eq(classesTable.label, label),
    ));
  if (!c) return null;

  await db.delete(classesTable).where(eq(classesTable.id, c.id));
  return true;
}

export async function disableGate(apiKeyId: number, name: string) {
  const db = getDb();
  const [gate] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(and(eq(gatesTable.apiKeyId, apiKeyId), eq(gatesTable.name, name)));

  if (!gate) return false;

  await db
    .update(gatesTable)
    .set({ enabled: 0, updatedAt: new Date() })
    .where(eq(gatesTable.id, gate.id));
  return true;
}

export async function transferGates(fromKeyId: number, toKeyId: number) {
  const db = getDb();
  await db
    .update(gatesTable)
    .set({ apiKeyId: toKeyId })
    .where(eq(gatesTable.apiKeyId, fromKeyId));
}

