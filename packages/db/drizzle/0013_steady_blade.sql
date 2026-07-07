CREATE TYPE "public"."team_billing_seat_sync_status" AS ENUM('synced', 'pending_provider_update', 'over_limit', 'error');--> statement-breakpoint
CREATE TABLE "team_billing_seat_states" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"seat_limit" integer,
	"billable_seat_count" integer DEFAULT 0 NOT NULL,
	"pending_billing_seat_count" integer DEFAULT 0 NOT NULL,
	"sync_status" "team_billing_seat_sync_status" DEFAULT 'synced' NOT NULL,
	"over_limit_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_message" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_billing_seat_states_counts_check" CHECK ("team_billing_seat_states"."billable_seat_count" >= 0
        and "team_billing_seat_states"."pending_billing_seat_count" >= 0
        and ("team_billing_seat_states"."seat_limit" is null or "team_billing_seat_states"."seat_limit" >= 0))
);
--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD CONSTRAINT "team_billing_seat_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD CONSTRAINT "team_billing_seat_states_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_billing_seat_states_status_idx" ON "team_billing_seat_states" USING btree ("sync_status","updated_at" DESC NULLS LAST);