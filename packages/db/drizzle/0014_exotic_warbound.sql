DROP INDEX "sessions_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "sessions_source_hash_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_personal_idempotency_key_unique" ON "sessions" USING btree ("owner_user_id","idempotency_key") WHERE "sessions"."visibility" = 'personal' and "sessions"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_personal_source_hash_unique" ON "sessions" USING btree ("owner_user_id","source_hash") WHERE "sessions"."visibility" = 'personal' and "sessions"."source_hash" is not null;