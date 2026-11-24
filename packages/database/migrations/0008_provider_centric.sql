CREATE TABLE "app_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"model" text NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adaptations" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "contract_observations" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "app_records" ADD CONSTRAINT "app_records_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_records_uq" ON "app_records" USING btree ("integration_id","model","key");--> statement-breakpoint
-- Data: name the provider of existing source/target facts (a pipeline's source and target are provider roles).
UPDATE "contract_observations" SET "provider" = split_part("contract", '.', 1) WHERE "boundary" IN ('source', 'target');--> statement-breakpoint
UPDATE "incidents" i SET "provider" = CASE
  WHEN i."boundary" = 'source' AND g."flow_type" LIKE '%ledgerly%' THEN 'stripe'
  WHEN i."boundary" = 'target' AND g."flow_type" LIKE '%ledgerly%' THEN 'quickbooks'
  WHEN i."boundary" = 'source' THEN 'shopify'
  WHEN i."boundary" = 'target' THEN 'netsuite' END
FROM "integrations" g WHERE g."id" = i."integration_id" AND i."boundary" IN ('source', 'target');--> statement-breakpoint
UPDATE "adaptations" a SET "provider" = CASE
  WHEN a."boundary" = 'source' AND g."flow_type" LIKE '%ledgerly%' THEN 'stripe'
  WHEN a."boundary" = 'target' AND g."flow_type" LIKE '%ledgerly%' THEN 'quickbooks'
  WHEN a."boundary" = 'source' THEN 'shopify'
  WHEN a."boundary" = 'target' THEN 'netsuite' END
FROM "integrations" g WHERE g."id" = a."integration_id" AND a."boundary" IN ('source', 'target');
