CREATE TABLE "judge_labels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "judge_labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"correct_class_id" integer,
	"model" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_watermark" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routing_events" ALTER COLUMN "scores" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "correct_class_id" integer;--> statement-breakpoint
ALTER TABLE "routing_events" ADD COLUMN "margin" real;--> statement-breakpoint
ALTER TABLE "routing_events" ADD COLUMN "entropy" real;--> statement-breakpoint
ALTER TABLE "judge_labels" ADD CONSTRAINT "judge_labels_event_id_routing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."routing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_labels" ADD CONSTRAINT "judge_labels_correct_class_id_classes_id_fk" FOREIGN KEY ("correct_class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_judge_labels_event" ON "judge_labels" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_correct_class_id_classes_id_fk" FOREIGN KEY ("correct_class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;