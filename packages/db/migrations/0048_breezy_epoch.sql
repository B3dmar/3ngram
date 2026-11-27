-- issue #506: the login that authorized a grant for a different account.
-- Both columns are new and NULL on every existing row, so the foreign keys are
-- added NOT VALID: validation would only scan oauth_codes and oauth_tokens
-- while holding locks on them and on users, to find nothing to check. NOT
-- VALID still enforces the key on every INSERT and UPDATE from here on.
ALTER TABLE "oauth_codes" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
