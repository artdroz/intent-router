CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"name" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "classes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"gate_id" integer NOT NULL,
	"gate_name" text NOT NULL,
	"label" text NOT NULL,
	"utterances" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"promoted_keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"weight" real DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "embeddings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"class_id" integer NOT NULL,
	"gate_name" text NOT NULL,
	"label" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source" text DEFAULT 'config' NOT NULL,
	"embedding" vector NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"route_id" text NOT NULL,
	"positive" integer NOT NULL,
	"extracted_keywords" text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"api_key_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "routing_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "routing_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"route_id" text NOT NULL,
	"api_key_id" integer NOT NULL,
	"gate_id" integer NOT NULL,
	"prompt" text NOT NULL,
	"predicted_class_id" integer NOT NULL,
	"stage" text NOT NULL,
	"scores" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "routing_events_route_id_unique" UNIQUE("route_id")
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_route_id_routing_events_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routing_events"("route_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_predicted_class_id_classes_id_fk" FOREIGN KEY ("predicted_class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_class" ON "classes" USING btree ("gate_name","label");--> statement-breakpoint
CREATE INDEX "idx_classes_gate" ON "classes" USING btree ("gate_id");--> statement-breakpoint
CREATE INDEX "idx_embeddings_gate" ON "embeddings" USING btree ("gate_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_embedding_class_content" ON "embeddings" USING btree ("class_id","content_hash");--> statement-breakpoint
CREATE INDEX "idx_feedback_route" ON "feedback" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "idx_gates_apikey" ON "gates" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_routing_gate" ON "routing_events" USING btree ("gate_id");