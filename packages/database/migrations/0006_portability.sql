-- Slice 6: one onboarding per (customer, integration kind). Existing onboardings are for the adopted
-- Shopify → NetSuite integration, the only self-onboardable kind before this slice.
ALTER TABLE "onboardings" ADD COLUMN "flow_type" text;--> statement-breakpoint
UPDATE "onboardings" SET "flow_type" = 'adopted.shopify_erp_order_sync.netsuite' WHERE "flow_type" IS NULL;--> statement-breakpoint
ALTER TABLE "onboardings" ALTER COLUMN "flow_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "onboardings" DROP CONSTRAINT "onboardings_pkey";--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_tenant_id_flow_type_pk" PRIMARY KEY("tenant_id","flow_type");
