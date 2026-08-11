import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import { gates as gatesTable, classes as classesTable } from "./schema.js";
import type { CreateGateInput, UpdateGateInput } from "../gates/schema.js";

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

  if (input.classes) {
    await db.delete(classesTable).where(eq(classesTable.gateId, existingGate.id));
    if (input.classes.length > 0) {
      await db.insert(classesTable).values(
        input.classes.map((c) => ({
          gateId: existingGate.id,
          gateName: input.name ?? existingGate.name,
          label: c.label,
          utterances: c.utterances,
          keywords: c.keywords ?? [],
        })),
      );
    }
  }

  return getGateByName(apiKeyId, input.name ?? name);
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

