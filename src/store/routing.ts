import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { routingEvents, feedback as feedbackTable, classes as classesTable, gates as gatesTable } from "./schema.js";
import type { NewRoutingEvent } from "./schema.js";

export async function insertRouteEvent(event: NewRoutingEvent) {
  const db = getDb();
  await db.insert(routingEvents).values(event);
}

export async function insertFeedback(
  routeId: string,
  positive: number,
  extractedKeywords?: string[],
) {
  const db = getDb();
  await db.insert(feedbackTable).values({ routeId, positive, extractedKeywords });
}

/** Get a route event by its public ID (for feedback linking). */
export async function getRouteByRouteId(routeId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(routingEvents)
    .where(eq(routingEvents.routeId, routeId));
  return row ?? null;
}

/** Replace the entire promotedKeywords list for a class. */
export async function replacePromotedKeywords(classId: number, keywords: string[]) {
  const db = getDb();
  await db
    .update(classesTable)
    .set({ promotedKeywords: keywords })
    .where(eq(classesTable.id, classId));
}

/** Get all gate IDs that have feedback. 
 * Filter by enabled gates to avoid wasting compute on same result in cron jobs.
 */
export async function getGateIdsWithFeedback() {
  const db = getDb();
  const rows = await db
    .selectDistinct({ gateId: routingEvents.gateId })
    .from(routingEvents)
    .innerJoin(feedbackTable, eq(feedbackTable.routeId, routingEvents.routeId))
    .innerJoin(gatesTable, eq(gatesTable.id, routingEvents.gateId))
    .where(eq(gatesTable.enabled, 1));
  return rows.map((r) => r.gateId);
}

/**
 * Get the feedback corpus for an entire gate: all (classId, keywords, positive)
 * rows across all classes in the gate.
 */
export async function getFeedbackCorpusByGate(gateId: number) {
  const db = getDb();
  return db
    .select({
      classId: routingEvents.predictedClassId,
      keywords: feedbackTable.extractedKeywords,
      positive: feedbackTable.positive,
    })
    .from(feedbackTable)
    .innerJoin(routingEvents, eq(feedbackTable.routeId, routingEvents.routeId))
    .where(eq(routingEvents.gateId, gateId));
}
