CREATE TYPE "public"."device_credential_verifier_kind" AS ENUM('secret_hash', 'public_key_jwk');--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"enrollment_challenge_id" uuid,
	"credential_key_id" text NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"device_instance_id" text NOT NULL,
	"device_label" text,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"verifier_kind" "device_credential_verifier_kind" NOT NULL,
	"verifier_hash" text,
	"public_key_jwk" jsonb,
	"operation_families" text[] DEFAULT array[]::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "device_credentials_credential_key_id_unique" UNIQUE("credential_key_id"),
	CONSTRAINT "device_credentials_credential_version_check" CHECK ("device_credentials"."credential_version" > 0),
	CONSTRAINT "device_credentials_credential_key_id_length_check" CHECK (length("device_credentials"."credential_key_id") >= 16),
	CONSTRAINT "device_credentials_verifier_hash_length_check" CHECK ("device_credentials"."verifier_hash" is null or length("device_credentials"."verifier_hash") >= 32),
	CONSTRAINT "device_credentials_verifier_shape_check" CHECK ((
        "device_credentials"."verifier_kind" = 'secret_hash'
        and "device_credentials"."verifier_hash" is not null
        and "device_credentials"."public_key_jwk" is null
      ) or (
        "device_credentials"."verifier_kind" = 'public_key_jwk'
        and "device_credentials"."public_key_jwk" is not null
        and "device_credentials"."verifier_hash" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "device_enrollment_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_hash" text NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"device_instance_id" text,
	"device_label" text,
	"requested_operation_families" text[] DEFAULT array[]::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bound_by_user_id" uuid,
	"bound_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "device_enrollment_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "device_enrollment_challenges_challenge_hash_length_check" CHECK (length("device_enrollment_challenges"."challenge_hash") >= 32)
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_enrollment_challenge_id_device_enrollment_challenges_id_fk" FOREIGN KEY ("enrollment_challenge_id") REFERENCES "public"."device_enrollment_challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD CONSTRAINT "device_enrollment_challenges_bound_by_user_id_users_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_credentials_active_lookup_idx" ON "device_credentials" USING btree ("credential_key_id") WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "device_credentials_owner_upstream_idx" ON "device_credentials" USING btree ("owner_user_id","upstream_backend_id","created_at" DESC NULLS LAST) WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_credentials_active_device_unique" ON "device_credentials" USING btree ("owner_user_id","upstream_backend_id","device_instance_id") WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "device_enrollment_challenges_active_idx" ON "device_enrollment_challenges" USING btree ("challenge_hash") WHERE "device_enrollment_challenges"."redeemed_at" is null;