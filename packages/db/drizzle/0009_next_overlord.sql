CREATE TYPE "public"."external_auth_link_status" AS ENUM('linked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."external_auth_provider" AS ENUM('workos_authkit');--> statement-breakpoint
CREATE TABLE "external_auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "external_auth_provider" NOT NULL,
	"provider_environment" text DEFAULT 'default' NOT NULL,
	"provider_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"status" "external_auth_link_status" DEFAULT 'linked' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "external_auth_identities_provider_user_unique" UNIQUE("provider","provider_environment","provider_user_id"),
	CONSTRAINT "external_auth_identities_provider_user_id_not_empty_check" CHECK (length(trim("external_auth_identities"."provider_user_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "external_auth_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "external_auth_provider" NOT NULL,
	"provider_environment" text DEFAULT 'default' NOT NULL,
	"provider_organization_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text,
	"status" "external_auth_link_status" DEFAULT 'linked' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "external_auth_organizations_provider_org_unique" UNIQUE("provider","provider_environment","provider_organization_id"),
	CONSTRAINT "external_auth_organizations_provider_org_id_not_empty_check" CHECK (length(trim("external_auth_organizations"."provider_organization_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "external_auth_identities" ADD CONSTRAINT "external_auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_auth_organizations" ADD CONSTRAINT "external_auth_organizations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_auth_identities_user_idx" ON "external_auth_identities" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "external_auth_organizations_team_idx" ON "external_auth_organizations" USING btree ("team_id","status");