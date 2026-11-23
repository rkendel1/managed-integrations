ALTER TABLE "integrations" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "config_version" integer DEFAULT 1 NOT NULL;