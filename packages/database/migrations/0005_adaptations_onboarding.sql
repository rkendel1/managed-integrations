CREATE TABLE "adaptations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"maintenance_event_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"dependency" jsonb NOT NULL,
	"code_path" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation" jsonb,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboardings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'connect' NOT NULL,
	"discovery" jsonb,
	"confirmation" jsonb,
	"integration_id" uuid,
	"activation" jsonb,
	"problem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_maintenance_event_id_incidents_id_fk" FOREIGN KEY ("maintenance_event_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adaptations_integration_status_idx" ON "adaptations" USING btree ("integration_id","status");--> statement-breakpoint
-- Data: slice-4 compatibility rules move from integration configuration into the correction registry
-- (single authority), keeping their maintenance event, validation and activation time.
INSERT INTO "adaptations" ("tenant_id", "integration_id", "maintenance_event_id", "kind", "status", "artifact", "dependency", "code_path", "spec", "rationale", "evidence", "validation", "history", "activated_at")
SELECT i."tenant_id", i."id", (r->>'maintenanceEventId')::uuid, 'adapter', 'active',
  jsonb_build_object('repository', 'https://github.com/Milo-ai-HQ/shopify-erp-order-sync', 'commit', 'd01b51d95993598580cdcffda6537a6f20a10a3a', 'package', 'shopify-sync'),
  jsonb_build_object('provider', 'shopify', 'topic', inc."finding"->>'topic', 'version', inc."finding"->'observed'->>'apiVersion', 'field', r->>'target'),
  coalesce(inc."investigation"->'codePaths'->0, '{}'::jsonb),
  jsonb_build_object('type', 'field_moved', 'target', r->>'target', 'source', r->>'source'),
  'Migrated from integration configuration (slice-4 compatibility rule).',
  jsonb_build_object('migratedFrom', 'integrations.config.inputCompat'),
  inc."validation",
  jsonb_build_array(jsonb_build_object('at', r->>'activatedAt', 'from', null, 'to', 'active', 'actor', 'system:maintenance', 'note', 'Activated by maintenance (slice 4)')),
  (r->>'activatedAt')::timestamptz
FROM "integrations" i
CROSS JOIN LATERAL jsonb_array_elements(coalesce(i."config"->'inputCompat', '[]'::jsonb)) r
LEFT JOIN "incidents" inc ON inc."id" = (r->>'maintenanceEventId')::uuid;
--> statement-breakpoint
UPDATE "integrations" SET "config" = "config" - 'inputCompat' WHERE "config" ? 'inputCompat';
