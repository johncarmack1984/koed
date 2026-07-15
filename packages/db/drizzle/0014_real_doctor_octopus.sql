CREATE TABLE "pds_relay_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transport_id" uuid NOT NULL,
	"chunk_index" text NOT NULL,
	"chunk_hash" text NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_bytes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_chunk_unique" UNIQUE("transport_id","chunk_index"),
	CONSTRAINT "pds_relay_chunk_index_check" CHECK ("pds_relay_chunks"."chunk_index" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_chunks"."ciphertext_bytes" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_relay_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"recipient_device_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"sequence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_cursor_unique" UNIQUE("group_id","recipient_device_id","origin_device_id"),
	CONSTRAINT "pds_relay_cursor_sequence_check" CHECK ("pds_relay_cursors"."sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_relay_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transport_id" uuid NOT NULL,
	"recipient_device_id" text NOT NULL,
	"ack_hash" text,
	"acked_at" timestamp with time zone,
	"waiver_hash" text,
	"waived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_recipient_unique" UNIQUE("transport_id","recipient_device_id")
);
--> statement-breakpoint
CREATE TABLE "pds_relay_request_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_nonce_unique" UNIQUE("group_id","device_id","nonce_digest")
);
--> statement-breakpoint
CREATE TABLE "pds_relay_transports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"transport_id" text NOT NULL,
	"sender_device_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"version" text NOT NULL,
	"content_epoch" text NOT NULL,
	"recipient_epoch" text NOT NULL,
	"authority_head" text NOT NULL,
	"payload_nonce" text NOT NULL,
	"payload_ciphertext_hash" text NOT NULL,
	"payload_tag" text NOT NULL,
	"plaintext_byte_count" text NOT NULL,
	"chunk_count" text NOT NULL,
	"ciphertext_bytes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"request_hash" text NOT NULL,
	"canonical_header" text NOT NULL,
	"canonical_envelopes" text NOT NULL,
	"package_digest" text,
	"state" text DEFAULT 'uploading' NOT NULL,
	"committed_at" timestamp with time zone,
	"cleanup_after" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_transport_sender_unique" UNIQUE("group_id","sender_device_id","transport_id"),
	CONSTRAINT "pds_relay_transport_state_check" CHECK ("pds_relay_transports"."state" in ('uploading','committed','expired','quarantined')),
	CONSTRAINT "pds_relay_transport_count_check" CHECK ("pds_relay_transports"."chunk_count" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_transports"."plaintext_byte_count" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_transports"."ciphertext_bytes" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
ALTER TABLE "pds_relay_chunks" ADD CONSTRAINT "pds_relay_chunks_transport_id_pds_relay_transports_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."pds_relay_transports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_cursors" ADD CONSTRAINT "pds_relay_cursors_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_recipients" ADD CONSTRAINT "pds_relay_recipients_transport_id_pds_relay_transports_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."pds_relay_transports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_request_nonces" ADD CONSTRAINT "pds_relay_request_nonces_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_transports" ADD CONSTRAINT "pds_relay_transports_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_relay_recipient_mailbox_idx" ON "pds_relay_recipients" USING btree ("recipient_device_id","acked_at");--> statement-breakpoint
CREATE INDEX "pds_relay_nonce_expiry_idx" ON "pds_relay_request_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pds_relay_transport_mailbox_idx" ON "pds_relay_transports" USING btree ("group_id","state","expires_at");