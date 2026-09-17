import { eq, and, desc, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  routingEvents,
  feedback as feedbackTable,
  gates as gatesTable,
  promotedKeywords,
  classes as classesTable,
  judgeLabels,
  learningWatermark,
} from "./schema.js";
import type { NewRoutingEvent } from "./schema.js";

/** Insert a routing event row. */
export async function insertRouteEvent(event: NewRoutingEvent) {
  const db = getDb();
  await db.insert(routingEvents).values(event);
}

/** Insert a feedback row linked to a routing event. */
export async function insertFeedback(
  routeId: string,
  positive: number,
  extractedKeywords?: string[],
  source: "user" | "judge" = "user",
  correctClassId?: number | null,
) {
  const db = getDb();
  await db.insert(feedbackTable).values({
    routeId,
    positive,
    extractedKeywords,
    source,
    correctClassId: correctClassId ?? null,
  });
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

/** Return the promoted keywords for a (class, tenant) pair, or an empty list. */
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
export async function getTenantGatesWithFeedback(): Promise<
  { tenantId: string; gateId: number }[]
> {
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
  // Skip events whose tenant/gate was deleted (FK set NULL): they can't be
  // attributed to a live tenant-gate pair.
  return rows.filter(
    (r): r is { tenantId: string; gateId: number } => r.tenantId !== null && r.gateId !== null,
  );
}

/**
 * Get the feedback corpus for a gate-tenant pair: all (classId, keywords, positive)
 * rows across all classes in the gate. A judge label expands to a positive doc
 * for the gold class and, when different, a negative doc for the predicted class.
 */
export async function getFeedbackCorpusByTenantGate(tenantId: string, gateId: number) {
  const db = getDb();
  const rows = await db
    .select({
      predictedClassId: routingEvents.predictedClassId,
      correctClassId: feedbackTable.correctClassId,
      source: feedbackTable.source,
      keywords: feedbackTable.extractedKeywords,
      positive: feedbackTable.positive,
    })
    .from(feedbackTable)
    .innerJoin(routingEvents, eq(feedbackTable.routeId, routingEvents.routeId))
    .where(and(eq(routingEvents.tenantId, tenantId), eq(routingEvents.gateId, gateId)));

  return expandCorpusRows(rows);
}

/**
 * Expand raw feedback rows into (classId, keywords, positive) corpus docs. A
 * judge label expands to a positive doc for the gold class and, when different,
 * a negative doc for the predicted class. User feedback maps 1:1.
 */
export function expandCorpusRows(
  rows: {
    predictedClassId: number | null;
    correctClassId: number | null;
    source: string;
    keywords: string[] | null;
    positive: number;
  }[],
): { classId: number; keywords: string[] | null; positive: number }[] {
  const corpus: { classId: number; keywords: string[] | null; positive: number }[] = [];
  for (const r of rows) {
    // Judge row with a gold class: teach the true class a positive doc, and
    // when the router disagreed, teach the predicted class a negative doc.
    if (r.source === "judge" && r.correctClassId !== null) {
      if (r.predictedClassId !== null && r.predictedClassId !== r.correctClassId) {
        corpus.push({ classId: r.predictedClassId, keywords: r.keywords, positive: 0 });
      }
      corpus.push({ classId: r.correctClassId, keywords: r.keywords, positive: 1 });
    } else if (r.source !== "judge" && r.predictedClassId !== null) {
      // User feedback (right/wrong about the prediction) maps 1:1 onto the
      // predicted class.
      corpus.push({ classId: r.predictedClassId, keywords: r.keywords, positive: r.positive });
    }
  }
  return corpus;
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

/** New routing events with no feedback yet, for the judge's sampling pass. */
export async function getUnjudgedCandidates(sinceId: number) {
  const db = getDb();
  const rows = await db
    .select({
      id: routingEvents.id,
      routeId: routingEvents.routeId,
      tenantId: routingEvents.tenantId,
      gateId: routingEvents.gateId,
      predictedClassId: routingEvents.predictedClassId,
      prompt: routingEvents.prompt,
      margin: routingEvents.margin,
      entropy: routingEvents.entropy,
    })
    .from(routingEvents)
    .leftJoin(feedbackTable, eq(feedbackTable.routeId, routingEvents.routeId))
    .where(and(gt(routingEvents.id, sinceId), isNull(feedbackTable.routeId)));
  return rows.filter(
    (
      r,
    ): r is {
      id: number;
      routeId: string;
      tenantId: string;
      gateId: number;
      predictedClassId: number;
      prompt: string;
      margin: number | null;
      entropy: number | null;
    } => r.tenantId !== null && r.gateId !== null && r.predictedClassId !== null,
  );
}

/** Row shape returned by {@link getUnjudgedCandidates}. */
export type JudgeCandidate = Awaited<ReturnType<typeof getUnjudgedCandidates>>[number];

/** Record a judge label on a routing event (audit + bias monitoring). */
export async function insertJudgeLabel(
  eventId: number,
  correctClassId: number | null,
  model: string,
  status: "ok" | "failed" = "ok",
) {
  const db = getDb();
  await db.insert(judgeLabels).values({
    eventId,
    correctClassId,
    model,
    status,
  });
}

/** Read a named learning watermark (0 when unset). */
export async function getLearningWatermark(key: string): Promise<number> {
  const db = getDb();
  const [row] = await db.select().from(learningWatermark).where(eq(learningWatermark.key, key));
  return row?.value ?? 0;
}

/** Upsert a named learning watermark. */
export async function setLearningWatermark(key: string, value: number) {
  const db = getDb();
  await db
    .insert(learningWatermark)
    .values({ key, value })
    .onConflictDoUpdate({ target: learningWatermark.key, set: { value } });
}
