CREATE TYPE "public"."team_entitlement_status" AS ENUM('active', 'grace', 'suspended', 'revoked');--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_status" "team_entitlement_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_reason" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_updated_at" timestamp with time zone;