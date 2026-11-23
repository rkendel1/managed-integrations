CREATE TABLE "reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"source_order_id" text NOT NULL,
	"source_legacy_id" text NOT NULL,
	"order_name" text NOT NULL,
	"source_created_at" timestamp with time zone NOT NULL,
	"classification" text NOT NULL,
	"reason" text,
	"delivery_id" uuid,
	"destination_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"recovery_state" text DEFAULT 'none' NOT NULL,
	"recovery_reason" text,
	"recovery_requested_by" text,
	"recovery_request_id" text,
	"recovery_requested_at" timestamp with time zone,
	"verified_destination_id" text,
	"verified_at" timestamp with time zone,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "pages_scanned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD COLUMN "origin" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_items_run_order_uq" ON "reconciliation_items" USING btree ("run_id","source_order_id");--> statement-breakpoint
CREATE INDEX "reconciliation_items_integration_idx" ON "reconciliation_items" USING btree ("integration_id","classification");