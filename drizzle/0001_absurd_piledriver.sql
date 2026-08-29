CREATE TABLE "promoted_keywords" (
	"tenant_id" uuid NOT NULL,
	"class_id" integer NOT NULL,
	"promoted_keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "promoted_keywords_tenant_id_class_id_pk" PRIMARY KEY("tenant_id","class_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_route_id_routing_events_route_id_fk";
--> statement-breakpoint
ALTER TABLE "gates" DROP CONSTRAINT "gates_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_gate_id_gates_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_predicted_class_id_classes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_gates_apikey";--> statement-breakpoint
DROP INDEX "uq_embedding_class_content";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_events" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "promoted_keywords" ADD CONSTRAINT "promoted_keywords_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoted_keywords" ADD CONSTRAINT "promoted_keywords_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_route_id_routing_events_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routing_events"("route_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_predicted_class_id_classes_id_fk" FOREIGN KEY ("predicted_class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_keys_tenant_name" ON "api_keys" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idx_embeddings_tenant" ON "embeddings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_embedding_tenant_class_content" ON "embeddings" USING btree ("tenant_id","class_id","content_hash") WHERE "embeddings"."tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_gates_tenant" ON "gates" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_embedding_class_content" ON "embeddings" USING btree ("class_id","content_hash") WHERE "embeddings"."tenant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "classes" DROP COLUMN "promoted_keywords";--> statement-breakpoint
ALTER TABLE "gates" DROP COLUMN "api_key_id";--> statement-breakpoint
ALTER TABLE "routing_events" DROP COLUMN "api_key_id";