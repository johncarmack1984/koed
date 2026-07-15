ALTER TABLE "pds_retained_packages" ADD COLUMN "logical_memory_id" text;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "deletion_floor_token" text;--> statement-breakpoint
CREATE INDEX "pds_retained_packages_floor_idx" ON "pds_retained_packages" USING btree ("group_id","deletion_floor_token");--> statement-breakpoint
CREATE TABLE "pds_tombstone_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "logical_memory_id" text NOT NULL,
  "deletion_floor_token" text NOT NULL,
  "tombstone_hash" text NOT NULL,
  "tombstone_sequence" text NOT NULL,
  "statement_hash" text NOT NULL,
  "encrypted_record" jsonb NOT NULL,
  "active_device_snapshot" text[] NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "quorum_completed_at" timestamp with time zone,
  "retain_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_tombstone_ledger_group_floor_unique" UNIQUE("group_id","deletion_floor_token"),
  CONSTRAINT "pds_tombstone_ledger_hash_unique" UNIQUE("group_id","tombstone_hash"),
  CONSTRAINT "pds_tombstone_ledger_sequence_check" CHECK ("tombstone_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_deletion_floors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "logical_memory_id" text NOT NULL,
  "deletion_floor_token" text NOT NULL,
  "tombstone_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_deletion_floor_group_token_unique" UNIQUE("group_id","deletion_floor_token"),
  CONSTRAINT "pds_deletion_floor_group_logical_unique" UNIQUE("group_id","logical_memory_id")
);
--> statement-breakpoint
CREATE TABLE "pds_tombstone_acks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tombstone_id" uuid NOT NULL,
  "device_id" text NOT NULL,
  "canonical_ack" text NOT NULL,
  "ack_hash" text NOT NULL,
  "acked_at" timestamp with time zone NOT NULL,
  "waived_at" timestamp with time zone,
  "waiver_statement_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_tombstone_ack_snapshot_unique" UNIQUE("tombstone_id","device_id"),
  CONSTRAINT "pds_tombstone_ack_hash_unique" UNIQUE("tombstone_id","ack_hash"),
  CONSTRAINT "pds_tombstone_ack_waiver_check" CHECK (("waived_at" is null) = ("waiver_statement_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "pds_replica_lifecycle_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "device_id" text NOT NULL,
  "authority_head" text NOT NULL,
  "authority_sequence" text NOT NULL,
  "lifecycle_high_water" text NOT NULL DEFAULT '0',
  "restore_high_water" text NOT NULL DEFAULT '0',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_replica_lifecycle_group_device_unique" UNIQUE("group_id","device_id"),
  CONSTRAINT "pds_replica_lifecycle_water_check" CHECK ("authority_sequence" ~ '^(0|[1-9][0-9]*)$' and "lifecycle_high_water" ~ '^(0|[1-9][0-9]*)$' and "restore_high_water" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_restore_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "device_id" text NOT NULL,
  "authority_head" text NOT NULL,
  "authority_sequence" text NOT NULL,
  "lifecycle_high_water" text NOT NULL,
  "outcome" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_restore_reconciliation_outcome_check" CHECK ("outcome" in ('accepted','rollback_rejected','authority_unavailable')),
  CONSTRAINT "pds_restore_reconciliation_sequence_check" CHECK ("authority_sequence" ~ '^(0|[1-9][0-9]*)$' and "lifecycle_high_water" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_conflict_resolution_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "source_fingerprint" text NOT NULL,
  "resolution_hash" text NOT NULL,
  "statement_hash" text NOT NULL,
  "resolution" text NOT NULL,
  "selected_closure_hash" text,
  "candidate_closure_hashes" text[] NOT NULL,
  "canonical_record" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pds_conflict_resolution_fingerprint_unique" UNIQUE("group_id","source_fingerprint"),
  CONSTRAINT "pds_conflict_resolution_hash_unique" UNIQUE("group_id","resolution_hash"),
  CONSTRAINT "pds_conflict_resolution_kind_check" CHECK (("resolution" = 'select' and "selected_closure_hash" is not null) or ("resolution" = 'distinct' and "selected_closure_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "pds_tombstone_ledger" ADD CONSTRAINT "pds_tombstone_ledger_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_deletion_floors" ADD CONSTRAINT "pds_deletion_floors_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_tombstone_acks" ADD CONSTRAINT "pds_tombstone_acks_tombstone_id_pds_tombstone_ledger_id_fk" FOREIGN KEY ("tombstone_id") REFERENCES "public"."pds_tombstone_ledger"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_lifecycle_state" ADD CONSTRAINT "pds_replica_lifecycle_state_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_restore_reconciliations" ADD CONSTRAINT "pds_restore_reconciliations_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_conflict_resolution_records" ADD CONSTRAINT "pds_conflict_resolution_records_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_tombstone_ledger_retention_idx" ON "pds_tombstone_ledger" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "pds_restore_reconciliation_group_created_idx" ON "pds_restore_reconciliations" USING btree ("group_id","created_at");
