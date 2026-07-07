CREATE TYPE "public"."deployment_profile" AS ENUM('developer_local', 'local_personal', 'private_vps', 'team_self_hosted', 'koed_managed_cloud');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('live', 'offload');--> statement-breakpoint
CREATE TYPE "public"."sync_package_state" AS ENUM('created', 'uploading', 'uploaded', 'verified', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_queue_entry_state" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_relationship_state" AS ENUM('created', 'uploading', 'uploaded', 'verified', 'processing', 'partially_available', 'ready', 'stale', 'failed', 'revoked', 'purge_pending');--> statement-breakpoint
CREATE TYPE "public"."sync_replica_role" AS ENUM('source', 'target');--> statement-breakpoint
CREATE TYPE "public"."sync_source_boundary" AS ENUM('captured_session');--> statement-breakpoint
CREATE TABLE "cross_identity_sync_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_replica_id" uuid NOT NULL,
	"target_replica_id" uuid NOT NULL,
	"source_deployment_identity_id" uuid NOT NULL,
	"target_deployment_identity_id" uuid NOT NULL,
	"source_owner_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"target_team_id" uuid,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"sync_mode" "sync_mode" DEFAULT 'live' NOT NULL,
	"state" "sync_relationship_state" DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"policy_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_package_id" uuid,
	"last_synced_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_message" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "cross_identity_sync_relationships_owner_idempotency_unique" UNIQUE("source_owner_user_id","idempotency_key"),
	CONSTRAINT "cross_identity_sync_relationships_captured_session_source_check" CHECK ("cross_identity_sync_relationships"."source_boundary" <> 'captured_session' or "cross_identity_sync_relationships"."source_session_id" is not null),
	CONSTRAINT "cross_identity_sync_relationships_idempotency_key_not_empty_check" CHECK (length(trim("cross_identity_sync_relationships"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "deployment_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"deployment_key" text NOT NULL,
	"profile" "deployment_profile" NOT NULL,
	"display_name" text,
	"base_url" text,
	"upstream_backend_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "deployment_identities_owner_key_unique" UNIQUE("owner_user_id","deployment_key"),
	CONSTRAINT "deployment_identities_deployment_key_not_empty_check" CHECK (length(trim("deployment_identities"."deployment_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "logical_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"logical_key" text NOT NULL,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "logical_memories_owner_key_unique" UNIQUE("owner_user_id","logical_key"),
	CONSTRAINT "logical_memories_captured_session_source_check" CHECK ("logical_memories"."source_boundary" <> 'captured_session' or "logical_memories"."source_session_id" is not null),
	CONSTRAINT "logical_memories_logical_key_not_empty_check" CHECK (length(trim("logical_memories"."logical_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"deployment_identity_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"replica_role" "sync_replica_role" NOT NULL,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"external_replica_id" text,
	"freshness_status" text DEFAULT 'unknown' NOT NULL,
	"cursor_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"stale_after" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "memory_replicas_logical_deployment_role_unique" UNIQUE("logical_memory_id","deployment_identity_id","replica_role"),
	CONSTRAINT "memory_replicas_captured_session_source_check" CHECK ("memory_replicas"."source_boundary" <> 'captured_session' or "memory_replicas"."source_session_id" is not null),
	CONSTRAINT "memory_replicas_freshness_status_check" CHECK ("memory_replicas"."freshness_status" in ('unknown', 'fresh', 'stale', 'revoked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sync_inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"state" "sync_queue_entry_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_inbox_entries_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_inbox_entries_attempts_check" CHECK ("sync_inbox_entries"."attempt_count" >= 0 and "sync_inbox_entries"."max_attempts" > 0 and "sync_inbox_entries"."attempt_count" <= "sync_inbox_entries"."max_attempts"),
	CONSTRAINT "sync_inbox_entries_idempotency_key_not_empty_check" CHECK (length(trim("sync_inbox_entries"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_outbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"state" "sync_queue_entry_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_outbox_entries_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_outbox_entries_attempts_check" CHECK ("sync_outbox_entries"."attempt_count" >= 0 and "sync_outbox_entries"."max_attempts" > 0 and "sync_outbox_entries"."attempt_count" <= "sync_outbox_entries"."max_attempts"),
	CONSTRAINT "sync_outbox_entries_idempotency_key_not_empty_check" CHECK (length(trim("sync_outbox_entries"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_package_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_session_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_checksum" text NOT NULL,
	"byte_count" integer NOT NULL,
	"storage_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_package_chunks_session_index_unique" UNIQUE("upload_session_id","chunk_index"),
	CONSTRAINT "sync_package_chunks_index_check" CHECK ("sync_package_chunks"."chunk_index" >= 0),
	CONSTRAINT "sync_package_chunks_byte_count_check" CHECK ("sync_package_chunks"."byte_count" >= 0),
	CONSTRAINT "sync_package_chunks_checksum_not_empty_check" CHECK (length(trim("sync_package_chunks"."chunk_checksum")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_package_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_replica_id" uuid NOT NULL,
	"target_replica_id" uuid NOT NULL,
	"state" "sync_package_state" DEFAULT 'created' NOT NULL,
	"package_format_version" integer DEFAULT 1 NOT NULL,
	"package_manifest" jsonb NOT NULL,
	"package_checksum" text NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"verified_chunk_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_message" text,
	CONSTRAINT "sync_package_upload_sessions_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_package_upload_sessions_checksum_not_empty_check" CHECK (length(trim("sync_package_upload_sessions"."package_checksum")) > 0),
	CONSTRAINT "sync_package_upload_sessions_idempotency_key_not_empty_check" CHECK (length(trim("sync_package_upload_sessions"."idempotency_key")) > 0),
	CONSTRAINT "sync_package_upload_sessions_counts_check" CHECK ("sync_package_upload_sessions"."package_format_version" > 0
        and "sync_package_upload_sessions"."total_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" <= "sync_package_upload_sessions"."total_bytes"
        and "sync_package_upload_sessions"."chunk_count" >= 0
        and "sync_package_upload_sessions"."verified_chunk_count" >= 0
        and "sync_package_upload_sessions"."verified_chunk_count" <= "sync_package_upload_sessions"."chunk_count")
);
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_replica_id_memory_replicas_id_fk" FOREIGN KEY ("source_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_replica_id_memory_replicas_id_fk" FOREIGN KEY ("target_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("source_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("target_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_owner_user_id_users_id_fk" FOREIGN KEY ("source_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_team_id_teams_id_fk" FOREIGN KEY ("target_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_identities" ADD CONSTRAINT "deployment_identities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD CONSTRAINT "sync_inbox_entries_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD CONSTRAINT "sync_inbox_entries_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD CONSTRAINT "sync_outbox_entries_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD CONSTRAINT "sync_outbox_entries_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_chunks" ADD CONSTRAINT "sync_package_chunks_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_source_replica_id_memory_replicas_id_fk" FOREIGN KEY ("source_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_target_replica_id_memory_replicas_id_fk" FOREIGN KEY ("target_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cross_identity_sync_relationships_active_replicas_unique" ON "cross_identity_sync_relationships" USING btree ("source_replica_id","target_replica_id","sync_mode") WHERE "cross_identity_sync_relationships"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_source_owner_idx" ON "cross_identity_sync_relationships" USING btree ("source_owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_target_user_idx" ON "cross_identity_sync_relationships" USING btree ("target_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_state_idx" ON "cross_identity_sync_relationships" USING btree ("state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployment_identities_owner_profile_idx" ON "deployment_identities" USING btree ("owner_user_id","profile","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "logical_memories_owner_session_unique" ON "logical_memories" USING btree ("owner_user_id","source_session_id") WHERE "logical_memories"."source_session_id" is not null;--> statement-breakpoint
CREATE INDEX "logical_memories_owner_boundary_idx" ON "logical_memories" USING btree ("owner_user_id","source_boundary","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_replicas_external_replica_unique" ON "memory_replicas" USING btree ("deployment_identity_id","external_replica_id") WHERE "memory_replicas"."external_replica_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_replicas_owner_status_idx" ON "memory_replicas" USING btree ("owner_user_id","freshness_status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_inbox_entries_state_idx" ON "sync_inbox_entries" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "sync_outbox_entries_state_idx" ON "sync_outbox_entries" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "sync_package_upload_sessions_state_idx" ON "sync_package_upload_sessions" USING btree ("state","updated_at" DESC NULLS LAST);
