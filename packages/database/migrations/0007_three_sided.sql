CREATE TABLE "contract_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"boundary" text NOT NULL,
	"contract" text NOT NULL,
	"version" text,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"sample" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adaptations" ADD COLUMN "boundary" text DEFAULT 'source' NOT NULL;--> statement-breakpoint
ALTER TABLE "adaptations" ADD COLUMN "impact" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "boundary" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "impact_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "contract_observations" ADD CONSTRAINT "contract_observations_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_observations_uq" ON "contract_observations" USING btree ("integration_id","contract","fingerprint");--> statement-breakpoint
-- Data: classify existing corrections and maintenance events by the component that changed.
UPDATE "adaptations" SET "boundary" = 'integration' WHERE "kind" = 'patch';--> statement-breakpoint
UPDATE "incidents" SET "boundary" = 'source' WHERE "kind" = 'input_contract_change' AND "boundary" IS NULL;--> statement-breakpoint
UPDATE "incidents" SET "boundary" = 'integration' WHERE "kind" = 'dependency_contract_change' AND "boundary" IS NULL;
