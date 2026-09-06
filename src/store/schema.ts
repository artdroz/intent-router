import {
  pgTable,
  text,
  integer,
  real,
  uniqueIndex,
  jsonb,
  timestamp,
  customType,
  index,
  uuid,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  // pgvector expects the literal `[a,b,c,...]` format, not a PG array `{...}`.
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").filter(Boolean).map(Number);
  },
});

export const EMBEDDING_SOURCES = ["config", "pos_feedback", "neg_feedback"] as const;
export type EmbeddingSource = (typeof EMBEDDING_SOURCES)[number];

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type GateRow = typeof gates.$inferSelect;
export type ClassRow = typeof classes.$inferSelect;
export type EmbeddingRow = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type PromotedKeywordRow = typeof promotedKeywords.$inferSelect;
export type NewPromotedKeyword = typeof promotedKeywords.$inferInsert;
export type RoutingEventRow = typeof routingEvents.$inferSelect;
export type NewRoutingEvent = typeof routingEvents.$inferInsert;

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* API Keys for requests not autenticated by LiteLLM proxy. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled").notNull().default(1),
    expiresAt: timestamp("expires_at"), // null = never expires
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [uniqueIndex("uq_api_keys_tenant_name").on(t.tenantId, t.name)],
);

export const gates = pgTable(
  "gates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // NULL = system/default gate (shared across all tenants)
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull().unique(),
    description: text("description"),
    config: jsonb("config").notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_gates_tenant").on(t.tenantId)],
);

export const classes = pgTable(
  "classes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    gateId: integer("gate_id")
      .notNull()
      .references(() => gates.id, { onDelete: "cascade" }),
    // Denormalized for easier querying; must match the gate's name.
    gateName: text("gate_name").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    utterances: text("utterances")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    weight: real("weight").notNull().default(1.0),
  },
  (t) => [uniqueIndex("uq_class").on(t.gateName, t.label), index("idx_classes_gate").on(t.gateId)],
);

export const embeddings = pgTable(
  "embeddings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // "config" = per-class config embedding; "pos_feedback" = tenant-specific learnt
    // embedding; "neg_feedback" = negative guardrail (explicit-veto evidence)
    source: text("source").notNull().default("config").$type<EmbeddingSource>(),
    // NULL = config embeddings; non-NULL = tenant-specific learnt embeddings
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    classId: integer("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    // Denormalized for easier querying; must match the class's gate name.
    gateName: text("gate_name").notNull(),
    label: text("label").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding").notNull(),
  },
  (t) => [
    index("idx_embeddings_gate").on(t.gateName),
    index("idx_embeddings_tenant").on(t.tenantId),
    // Shared config embeddings: dedupe by (classId, contentHash).
    uniqueIndex("uq_embedding_class_content")
      .on(t.classId, t.contentHash)
      .where(sql`${t.tenantId} IS NULL`),
    // Tenant-specific learnt embeddings: dedupe by (tenantId, classId, contentHash, source),
    // so a positive and a negative guardrail for the same utterance can coexist.
    uniqueIndex("uq_embedding_tenant_class_content")
      .on(t.tenantId, t.classId, t.contentHash, t.source)
      .where(sql`${t.tenantId} IS NOT NULL`),
  ],
);

export const promotedKeywords = pgTable(
  "promoted_keywords",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    classId: integer("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    promotedKeywords: text("promoted_keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.classId] })],
);

export const feedback = pgTable(
  "feedback",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    routeId: text("route_id")
      .notNull()
      .references(() => routingEvents.routeId, { onDelete: "cascade" }),
    positive: integer("positive").notNull(),
    extractedKeywords: text("extracted_keywords").array(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_feedback_route").on(t.routeId)],
);

export const routingEvents = pgTable(
  "routing_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    routeId: text("route_id").notNull().unique(), // public ID returned to caller
    // Audit trail survives parent deletion: NULL means the referenced
    // tenant/gate/class was deleted after this event was logged.
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    gateId: integer("gate_id").references(() => gates.id, { onDelete: "set null" }),
    prompt: text("prompt").notNull(),
    predictedClassId: integer("predicted_class_id").references(() => classes.id, {
      onDelete: "set null",
    }),
    stage: text("stage").notNull(), // 'keyword' | 'semantic' | 'llm'
    scores: jsonb("scores").notNull(), // { label: score, ... }
    channel: text("channel").notNull().default("rest"), // 'rest' | 'litellm'
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_routing_gate").on(t.gateId)],
);
