ALTER TABLE "incidents" ADD COLUMN "finding" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "investigation" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "correction" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "accounting" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD COLUMN "api_version" text;