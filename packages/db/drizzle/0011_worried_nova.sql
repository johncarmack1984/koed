CREATE TABLE "encrypted_field_backfill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"source_table" text NOT NULL,
	"source_column" text NOT NULL,
	"provider_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor_source_id" uuid,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"encrypted_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"last_error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encrypted_field_backfill_runs_source_table_check" CHECK ("encrypted_field_backfill_runs"."source_table" in (
        'conversation_items',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )),
	CONSTRAINT "encrypted_field_backfill_runs_provider_mode_check" CHECK ("encrypted_field_backfill_runs"."provider_mode" in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )),
	CONSTRAINT "encrypted_field_backfill_runs_status_check" CHECK ("encrypted_field_backfill_runs"."status" in ('pending', 'processing', 'completed', 'error')),
	CONSTRAINT "encrypted_field_backfill_runs_counts_check" CHECK ("encrypted_field_backfill_runs"."total_rows" >= 0
        and "encrypted_field_backfill_runs"."processed_rows" >= 0
        and "encrypted_field_backfill_runs"."encrypted_rows" >= 0
        and "encrypted_field_backfill_runs"."failed_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "encrypted_field_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_column" text NOT NULL,
	"plaintext_content_type" text DEFAULT 'application/json' NOT NULL,
	"plaintext_encoding" text DEFAULT 'utf8' NOT NULL,
	"envelope_version" integer NOT NULL,
	"provider_mode" text NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"algorithm" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"tag" text NOT NULL,
	"wrapped_dek" jsonb NOT NULL,
	"ciphertext_location" text NOT NULL,
	"aad" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"envelope_created_at" timestamp with time zone NOT NULL,
	"envelope_reencrypted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "encrypted_field_payloads_personal_owner_check" CHECK ("encrypted_field_payloads"."visibility" = 'personal' and "encrypted_field_payloads"."owner_user_id" is not null),
	CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )),
	CONSTRAINT "encrypted_field_payloads_provider_mode_check" CHECK ("encrypted_field_payloads"."provider_mode" in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )),
	CONSTRAINT "encrypted_field_payloads_key_version_check" CHECK ("encrypted_field_payloads"."key_version" >= 0),
	CONSTRAINT "encrypted_field_payloads_envelope_version_check" CHECK ("encrypted_field_payloads"."envelope_version" >= 1),
	CONSTRAINT "encrypted_field_payloads_ciphertext_not_empty_check" CHECK (length("encrypted_field_payloads"."ciphertext") > 0 and length("encrypted_field_payloads"."nonce") > 0 and length("encrypted_field_payloads"."tag") > 0)
);
--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" ADD CONSTRAINT "encrypted_field_backfill_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encrypted_field_backfill_runs_status_idx" ON "encrypted_field_backfill_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_field_payloads_source_unique" ON "encrypted_field_payloads" USING btree ("source_table","source_id","source_column") WHERE "encrypted_field_payloads"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_owner_idx" ON "encrypted_field_payloads" USING btree ("owner_user_id","source_table","updated_at" DESC NULLS LAST) WHERE "encrypted_field_payloads"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_key_idx" ON "encrypted_field_payloads" USING btree ("provider_mode","key_id","key_version");