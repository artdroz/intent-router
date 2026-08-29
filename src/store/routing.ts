import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  routingEvents,
  feedback as feedbackTable,
  gates as gatesTable,
  promotedKeywords,
  classes as classesTable,
} from "./schema.js";
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
  const [row] = await db.select().from(routingEvents).where(eq(routingEvents.routeId, routeId));
  return row ?? null;
}

/** Upsert the promoted keywords for a (class, tenant) pair. */
export async function updatePromotedKeywords(
  classId: number,
  tenantId: string,
  keywords: string[],
) {
  const db = getDb();
  await db
    .insert(promotedKeywords)
    .values({ tenantId, classId, promotedKeywords: keywords })
    .onConflictDoUpdate({
      target: [promotedKeywords.tenantId, promotedKeywords.classId],
      set: { promotedKeywords: keywords },
    });
}

export async function getPromotedKeywords(classId: number, tenantId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(promotedKeywords)
    .where(and(eq(promotedKeywords.classId, classId), eq(promotedKeywords.tenantId, tenantId)));
  return row?.promotedKeywords ?? [];
}

/** Get all gate-tenant pairs that have feedback.
 * Filter by enabled gates to avoid wasting compute on same result in cron jobs.
 */
export async function getTenantGatesWithFeedback() {
  const db = getDb();
  const rows = await db
    .selectDistinct({
      tenantId: routingEvents.tenantId,
      gateId: routingEvents.gateId,
    })
    .from(routingEvents)
    .innerJoin(feedbackTable, eq(feedbackTable.routeId, routingEvents.routeId))
    .innerJoin(gatesTable, eq(gatesTable.id, routingEvents.gateId))
    .where(eq(gatesTable.enabled, 1));
  return rows; // { tenantId, gateId }[]
}

/**
 * Get the feedback corpus for an gate-tenant pair: all (classId, keywords, positive)
 * rows across all classes in the gate.
 */
export async function getFeedbackCorpusByTenantGate(tenantId: string, gateId: number) {
  const db = getDb();
  return db
    .select({
      classId: routingEvents.predictedClassId,
      keywords: feedbackTable.extractedKeywords,
      positive: feedbackTable.positive,
    })
    .from(feedbackTable)
    .innerJoin(routingEvents, eq(feedbackTable.routeId, routingEvents.routeId))
    .where(and(eq(routingEvents.tenantId, tenantId), eq(routingEvents.gateId, gateId)));
}

/** Row shape returned by {@link getFeedbackCorpusByTenantGate}. */
export type FeedbackCorpusRow = Awaited<ReturnType<typeof getFeedbackCorpusByTenantGate>>[number];

/**
 * Most frequently predicted class label for a (tenant, gate) pair, used as a
 * last-resort fallback when every classifier fails.
 */
export async function getMostFrequentClass(
  tenantId: string,
  gateId: number,
): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ label: classesTable.label })
    .from(routingEvents)
    .innerJoin(classesTable, eq(classesTable.id, routingEvents.predictedClassId))
    .where(and(eq(routingEvents.tenantId, tenantId), eq(routingEvents.gateId, gateId)))
    .groupBy(classesTable.label)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(1);
  return row?.label ?? null;
}

/** Number of routing events that predicted the given class. */
export async function countRoutingEventsByClass(classId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(routingEvents)
    .where(eq(routingEvents.predictedClassId, classId));
  return row?.n ?? 0;
}
