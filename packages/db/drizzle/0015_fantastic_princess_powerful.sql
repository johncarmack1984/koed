ALTER TABLE "personal_sync_policies" ADD COLUMN "enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_sync_policies" ADD COLUMN "publication_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "personal_sync_policies" SET "enabled_at" = "updated_at" WHERE "enabled" = true;--> statement-breakpoint
CREATE TABLE "pds_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"source_fingerprint" text NOT NULL,
	"state" text DEFAULT 'quarantined' NOT NULL,
	"resolution_statement_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pds_conflict_fingerprint_unique" UNIQUE("group_id","source_fingerprint"),
	CONSTRAINT "pds_conflict_state_check" CHECK ("pds_conflicts"."state" in ('quarantined','resolved'))
);
--> statement-breakpoint
CREATE TABLE "pds_inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_class" text,
	"retained_package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_inbox_replay_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_inbox_state_check" CHECK ("pds_inbox_entries"."state" in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked')),
	CONSTRAINT "pds_inbox_attempt_count_check" CHECK ("pds_inbox_entries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pds_logical_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_fingerprint" text,
	"closure_hash" text NOT NULL,
	"local_session_id" uuid,
	"materialization_state" text DEFAULT 'pending' NOT NULL,
	"conflict_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_logical_replica_fingerprint_closure_unique" UNIQUE("group_id","source_fingerprint","closure_hash"),
	CONSTRAINT "pds_logical_replica_local_session_unique" UNIQUE("local_session_id"),
	CONSTRAINT "pds_logical_replica_state_check" CHECK ("pds_logical_replicas"."materialization_state" in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_origin_high_water_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"accepted_sequence" text DEFAULT '0' NOT NULL,
	"served_sequence" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_origin_high_water_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id"),
	CONSTRAINT "pds_origin_high_water_decimal_check" CHECK ("pds_origin_high_water_marks"."accepted_sequence" ~ '^(0|[1-9][0-9]*)$' and "pds_origin_high_water_marks"."served_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_origin_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"next_sequence" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_origin_sequence_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id"),
	CONSTRAINT "pds_origin_sequence_decimal_check" CHECK ("pds_origin_sequences"."next_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_outbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closure_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_class" text,
	"transport_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_outbox_closure_unique" UNIQUE("closure_id"),
	CONSTRAINT "pds_outbox_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "pds_outbox_state_check" CHECK ("pds_outbox_entries"."state" in ('pending','uploading','committed','acked','paused','failed','quarantined')),
	CONSTRAINT "pds_outbox_attempt_count_check" CHECK ("pds_outbox_entries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pds_replica_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"replica_id" uuid NOT NULL,
	"retained_package_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"source_sequence" text NOT NULL,
	"source_closed_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_replica_observation_origin_sequence_unique" UNIQUE("replica_id","origin_deployment_id","origin_device_id","source_sequence"),
	CONSTRAINT "pds_replica_observation_package_unique" UNIQUE("retained_package_id"),
	CONSTRAINT "pds_replica_observation_sequence_check" CHECK ("pds_replica_observations"."source_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_retained_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"source_sequence" text NOT NULL,
	"encrypted_envelope" jsonb NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_retained_package_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_retained_origin_sequence_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id","source_sequence"),
	CONSTRAINT "pds_retained_package_sequence_check" CHECK ("pds_retained_packages"."source_sequence" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "pds_retained_package_state_check" CHECK ("pds_retained_packages"."state" in ('ready','stale','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_session_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"source_sequence" text NOT NULL,
	"terminal_cursor" text NOT NULL,
	"terminal_item_count" text NOT NULL,
	"source_closure_hash" text NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_session_closure_session_unique" UNIQUE("group_id","source_session_id"),
	CONSTRAINT "pds_session_closure_sequence_unique" UNIQUE("group_id","source_sequence"),
	CONSTRAINT "pds_session_closure_package_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_session_closure_sequence_check" CHECK ("pds_session_closures"."source_sequence" ~ '^(0|[1-9][0-9]*)$' and "pds_session_closures"."terminal_cursor" ~ '^(0|[1-9][0-9]*)$' and "pds_session_closures"."terminal_item_count" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "pds_session_closure_state_check" CHECK ("pds_session_closures"."state" in ('ready','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_source_item_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closure_id" uuid,
	"replica_id" uuid,
	"conversation_item_id" uuid NOT NULL,
	"source_ordinal" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_source_item_mapping_item_unique" UNIQUE("conversation_item_id"),
	CONSTRAINT "pds_source_item_mapping_closure_ordinal_unique" UNIQUE("closure_id","source_ordinal"),
	CONSTRAINT "pds_source_item_mapping_replica_ordinal_unique" UNIQUE("replica_id","source_ordinal"),
	CONSTRAINT "pds_source_item_mapping_owner_check" CHECK (("pds_source_item_mappings"."closure_id" is null) <> ("pds_source_item_mappings"."replica_id" is null)),
	CONSTRAINT "pds_source_item_mapping_ordinal_check" CHECK ("pds_source_item_mappings"."source_ordinal" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_transport_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"transport_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_transport_mapping_transport_unique" UNIQUE("group_id","transport_id"),
	CONSTRAINT "pds_transport_mapping_package_direction_unique" UNIQUE("group_id","package_id","direction"),
	CONSTRAINT "pds_transport_mapping_direction_check" CHECK ("pds_transport_mappings"."direction" in ('outbound','inbound'))
);
--> statement-breakpoint
CREATE TABLE "pds_worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"worker_id" text NOT NULL,
	"capability" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_worker_heartbeat_unique" UNIQUE("group_id","worker_id","capability"),
	CONSTRAINT "pds_worker_heartbeat_capability_check" CHECK ("pds_worker_heartbeats"."capability" in ('source_publication','receiver_materialization'))
);
--> statement-breakpoint
ALTER TABLE "pds_conflicts" ADD CONSTRAINT "pds_conflicts_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_origin_high_water_marks" ADD CONSTRAINT "pds_origin_high_water_marks_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_origin_sequences" ADD CONSTRAINT "pds_origin_sequences_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_entries_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_observations" ADD CONSTRAINT "pds_replica_observations_replica_id_pds_logical_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."pds_logical_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_observations" ADD CONSTRAINT "pds_replica_observations_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD CONSTRAINT "pds_retained_packages_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD CONSTRAINT "pds_retained_packages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_replica_id_pds_logical_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."pds_logical_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_transport_mappings" ADD CONSTRAINT "pds_transport_mappings_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_worker_heartbeats" ADD CONSTRAINT "pds_worker_heartbeats_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_inbox_claim_idx" ON "pds_inbox_entries" USING btree ("state","retry_at");--> statement-breakpoint
CREATE INDEX "pds_logical_replica_recall_idx" ON "pds_logical_replicas" USING btree ("owner_user_id","materialization_state");--> statement-breakpoint
CREATE INDEX "pds_outbox_claim_idx" ON "pds_outbox_entries" USING btree ("state","retry_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_session_recall_ready(session_uuid uuid) RETURNS boolean AS $$
  SELECT session_uuid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pds_source_item_mappings m
    JOIN pds_logical_replicas r ON r.id=m.replica_id
    WHERE m.conversation_item_id IN (
      SELECT ci.id FROM conversation_items ci WHERE ci.session_id=session_uuid
    ) AND r.materialization_state <> 'ready'
  );
$$ LANGUAGE sql STABLE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_set_policy_enabled_at() RETURNS trigger AS $$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled THEN NEW.enabled_at = now(); END IF;
  IF NOT NEW.enabled THEN NEW.enabled_at = NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pds_personal_sync_policy_enabled_at
  BEFORE UPDATE OF enabled ON personal_sync_policies
  FOR EACH ROW EXECUTE FUNCTION pds_set_policy_enabled_at();--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_reject_closed_source_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'pds_session_closures' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
      OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence
      OR NEW.terminal_cursor IS DISTINCT FROM OLD.terminal_cursor
      OR NEW.terminal_item_count IS DISTINCT FROM OLD.terminal_item_count
      OR NEW.source_closure_hash IS DISTINCT FROM OLD.source_closure_hash
      OR NEW.package_id IS DISTINCT FROM OLD.package_id
      OR NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'PDS Session closure is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'sessions' AND TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = OLD.id) THEN
      RAISE EXCEPTION 'PDS replica Sessions are read-only';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Close path holds same lock while snapshotting. Insert either wins before
    -- snapshot or waits and is rejected after immutable closure commits.
    PERFORM pg_advisory_xact_lock(hashtext('pds-session:' || NEW.session_id::text));
    IF EXISTS (SELECT 1 FROM pds_session_closures c WHERE c.source_session_id = NEW.session_id AND c.state = 'ready') THEN
      RAISE EXCEPTION 'PDS closed source Session cannot accept later items';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM pds_source_item_mappings m WHERE m.conversation_item_id = OLD.id) THEN
      RAISE EXCEPTION 'PDS source items are read-only';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pds_session_closure_immutable
  BEFORE UPDATE ON pds_session_closures
  FOR EACH ROW EXECUTE FUNCTION pds_reject_closed_source_mutation();--> statement-breakpoint
CREATE TRIGGER pds_conversation_item_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON conversation_items
  FOR EACH ROW EXECUTE FUNCTION pds_reject_closed_source_mutation();--> statement-breakpoint
CREATE TRIGGER pds_replica_session_read_only
  BEFORE UPDATE OR DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION pds_reject_closed_source_mutation();