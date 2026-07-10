CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "password_reset_tokens" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

-- Atomic single-use consumption of a forgotten-password reset token,
-- mirroring auth_consume_oauth_code (0003). The token table has RLS ON,
-- so this SECURITY DEFINER resolver is the ONLY pre-tenant access path: the
-- reset POST presents a token hash and must resolve it to its user BEFORE any
-- tenant context exists. The UPDATE ... WHERE consumed_at IS NULL AND
-- expires_at > now() guarantees exactly one winner — a replayed, expired, or
-- unknown token returns no row, so single-use holds under concurrency without
-- any app-side locking. search_path is pinned (SECURITY DEFINER hygiene).
-- EXECUTE is REVOKED from PUBLIC here; the app_user grant lives in
-- scripts/provision-roles.sql (a grant in the migration aborts a fresh self-host
-- where app_user does not yet exist fresh-install lesson).
CREATE OR REPLACE FUNCTION auth_consume_password_reset_token(p_token_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE password_reset_tokens SET consumed_at = now()
  WHERE token_hash = p_token_hash AND consumed_at IS NULL AND expires_at > now()
  RETURNING user_id;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_consume_password_reset_token(text) FROM PUBLIC;