import { eq, and, inArray, or, isNull } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  gates as gatesTable,
  classes as classesTable,
  embeddings as embeddingsTable,
} from "./schema.js";
import type {
  CreateGateInput,
  UpdateGateInput,
  UpdateClassInput,
  AddClassInput,
} from "../gates/schema.js";

export async function createGate(tenantId: string | null, input: CreateGateInput) {
  const db = getDb();

  const gateId = await db.transaction(async (tx) => {
    const [gate] = await tx
      .insert(gatesTable)
      .values({
        tenantId: tenantId,
        name: input.name,
        description: input.description ?? null,
        config: input.config,
      })
      .returning({ id: gatesTable.id });

    if (input.classes.length > 0) {
      await tx.insert(classesTable).values(
        input.classes.map((c) => ({
          gateId: gate.id,
          gateName: input.name,
          label: c.label,
          description: c.description ?? null,
          utterances: c.utterances,
          keywords: c.keywords ?? [],
        })),
      );
    }

    return gate.id;
  });

  return getGateById(gateId);
}

export async function getGateByName(name: string) {
  const db = getDb();
  const [gate] = await db
    .select()
    .from(gatesTable)
    .where(and(eq(gatesTable.name, name), eq(gatesTable.enabled, 1)));

  if (!gate) return null;

  const gateClasses = await db.select().from(classesTable).where(eq(classesTable.gateId, gate.id));

  return { gate, classes: gateClasses };
}

export async function getGateById(id: number) {
  const db = getDb();
  const [gate] = await db.select().from(gatesTable).where(eq(gatesTable.id, id));
  if (!gate) return null;

  const gateClasses = await db.select().from(classesTable).where(eq(classesTable.gateId, gate.id));

  return { gate, classes: gateClasses };
}

/** Return tenant's own gates plus the system gates (tenant_id IS NULL). */
export async function getGatesByTenant(tenantId: string) {
  const db = getDb();
  const gateRows = await db
    .select()
    .from(gatesTable)
    .where(
      and(
        eq(gatesTable.enabled, 1),
        or(eq(gatesTable.tenantId, tenantId), isNull(gatesTable.tenantId)),
      ),
    )
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

export async function getClassById(id: number) {
  const db = getDb();
  const [row] = await db.select().from(classesTable).where(eq(classesTable.id, id));
  return row ?? null;
}

/** Check if a gate name is taken (both enabled or disabled). */
export async function gateNameExists(name: string) {
  const db = getDb();
  const [row] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(eq(gatesTable.name, name));
  return !!row;
}

export async function updateGate(name: string, input: UpdateGateInput) {
  const db = getDb();
  const existing = await getGateByName(name);
  if (!existing) return null;
  const existingGate = existing.gate;
  const newName = input.name ?? name;

  await db.transaction(async (tx) => {
    if (input.name) {
      // Update gateName in denormalized tables (classes and embeddings)
      await tx
        .update(classesTable)
        .set({ gateName: input.name })
        .where(eq(classesTable.gateId, existingGate.id));

      const classIds = await tx
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(eq(classesTable.gateId, existingGate.id));
      const ids = classIds.map((c) => c.id);

      if (ids.length > 0) {
        await tx
          .update(embeddingsTable)
          .set({ gateName: input.name })
          .where(inArray(embeddingsTable.classId, ids));
      }
    }

    if (input.name || input.description !== undefined || input.config) {
      await tx
        .update(gatesTable)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.config ? { config: input.config } : {}),
          updatedAt: new Date(),
        })
        .where(eq(gatesTable.id, existingGate.id));
    }
  });

  return getGateByName(newName);
}

export async function updateClass(gateName: string, label: string, input: UpdateClassInput) {
  const db = getDb();
  const gate = await getGateByName(gateName);
  if (!gate) return null;

  const [c] = await db
    .select()
    .from(classesTable)
    .where(and(eq(classesTable.gateId, gate.gate.id), eq(classesTable.label, label)));
  if (!c) return null;

  // The class row and the denormalised `label` column on its embeddings must
  // change atomically: a partial write would leave embeddings under a stale
  // label that the semantic classifier aggregates by.
  await db.transaction(async (tx) => {
    await tx
      .update(classesTable)
      .set({
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.utterances !== undefined ? { utterances: input.utterances } : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where(eq(classesTable.id, c.id));

    if (input.label && input.label !== label) {
      await tx
        .update(embeddingsTable)
        .set({ label: input.label })
        .where(eq(embeddingsTable.classId, c.id));
    }
  });

  // Re-fetch updated row
  const [updated] = await db.select().from(classesTable).where(eq(classesTable.id, c.id));
  return updated;
}

export async function addClass(gateName: string, input: AddClassInput) {
  const db = getDb();
  const gate = await getGateByName(gateName);
  if (!gate) return null;

  const [inserted] = await db
    .insert(classesTable)
    .values({
      gateId: gate.gate.id,
      gateName,
      label: input.label,
      description: input.description ?? null,
      utterances: input.utterances,
      keywords: input.keywords ?? [],
    })
    .returning();

  return inserted;
}

export async function deleteClass(gateName: string, label: string) {
  const db = getDb();
  const gate = await getGateByName(gateName);
  if (!gate) return null;

  const [c] = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(and(eq(classesTable.gateId, gate.gate.id), eq(classesTable.label, label)));
  if (!c) return null;

  await db.delete(classesTable).where(eq(classesTable.id, c.id));
  return true;
}

export async function disableGate(name: string) {
  const db = getDb();
  const [gate] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(and(eq(gatesTable.name, name)));

  if (!gate) return false;

  await db
    .update(gatesTable)
    .set({ enabled: 0, updatedAt: new Date() })
    .where(eq(gatesTable.id, gate.id));
  return true;
}

export async function transferGates(fromTenantId: string, toTenantId: string) {
  const db = getDb();
  await db
    .update(gatesTable)
    .set({ tenantId: toTenantId })
    .where(eq(gatesTable.tenantId, fromTenantId));
}
