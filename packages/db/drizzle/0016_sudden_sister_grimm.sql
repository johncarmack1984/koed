ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_personal_owner_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD COLUMN "team_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD COLUMN "encryption_scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_team_workspace_id_team_id_team_workspaces_id_team_id_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_team_idx" ON "encrypted_field_payloads" USING btree ("team_id","team_workspace_id","source_table") WHERE "encrypted_field_payloads"."encryption_scope" = 'team';--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_scope_owner_check" CHECK ((
        "encrypted_field_payloads"."encryption_scope" = 'personal'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."owner_user_id" is not null
        and "encrypted_field_payloads"."team_id" is null
        and "encrypted_field_payloads"."team_workspace_id" is null
      ) or (
        "encrypted_field_payloads"."encryption_scope" = 'team'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."team_id" is not null
      ));--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_encryption_scope_check" CHECK ("encrypted_field_payloads"."encryption_scope" in ('personal', 'team'));