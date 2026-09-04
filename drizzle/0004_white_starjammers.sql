ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_gate_id_gates_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" DROP CONSTRAINT "routing_events_predicted_class_id_classes_id_fk";
--> statement-breakpoint
ALTER TABLE "routing_events" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_events" ALTER COLUMN "gate_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_events" ALTER COLUMN "predicted_class_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_events" ADD CONSTRAINT "routing_events_predicted_class_id_classes_id_fk" FOREIGN KEY ("predicted_class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;