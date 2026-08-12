import { pgTable, text, integer, real, uniqueIndex, jsonb, timestamp, customType, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
});

export const apiKeys = pgTable("api_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  name: text("name").notNull(),
  enabled: integer("enabled").notNull().default(1),
  expiresAt: timestamp("expires_at"),              // null = never expires
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type GateRow = typeof gates.$inferSelect;
export type ClassRow = typeof classes.$inferSelect;
export type EmbeddingRow = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type RoutingEventRow = typeof routingEvents.$inferSelect;
export type NewRoutingEvent = typeof routingEvents.$inferInsert;

export const gates = pgTable("gates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  apiKeyId: integer("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  description: text("description"),
  config: jsonb("config").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_gates_apikey").on(t.apiKeyId),
]);

export const classes = pgTable("classes", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    gateId: integer("gate_id")
      .notNull()
      .references(() => gates.id, { onDelete: "cascade" }),
    gateName: text("gate_name").notNull(), 
    label: text("label").notNull(),
    utterances: text("utterances").array().notNull().default(sql`ARRAY[]::text[]`),
    keywords: text("keywords").array().notNull().default(sql`ARRAY[]::text[]`),
    promotedKeywords: text("promoted_keywords").array().notNull().default(sql`ARRAY[]::text[]`),
    weight: real("weight").notNull().default(1.0),
  },
  (t) => [
    uniqueIndex("uq_class").on(t.gateName, t.label),
    index("idx_classes_gate").on(t.gateId),
  ],
);

export const embeddings = pgTable("embeddings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  classId: integer("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  gateName: text("gate_name").notNull(),
  label: text("label").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("config"),
  embedding: vector("embedding").notNull(),
}, (t) => [
  index("idx_embeddings_gate").on(t.gateName),
]);

export const feedback = pgTable("feedback", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  routeId: text("route_id")
    .notNull()
    .references(() => routingEvents.routeId, { onDelete: "restrict" }),
  positive: integer("positive").notNull(),
  extractedKeywords: text("extracted_keywords").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const routingEvents = pgTable("routing_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  routeId: text("route_id").notNull().unique(),    // public ID returned to caller
  apiKeyId: integer("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  gateId: integer("gate_id")
    .notNull()
    .references(() => gates.id, { onDelete: "restrict" }),
  prompt: text("prompt").notNull(),
  predictedClassId: integer("predicted_class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "restrict" }),
  stage: text("stage").notNull(),             // 'keyword' | 'semantic' | 'llm'
  scores: jsonb("scores").notNull(),          // { label: score, ... }
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
