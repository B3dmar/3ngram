CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_verification_tokens_expires_idx" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_verification_tokens" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- Cheap read-only validity check used before argon2/session work on the verify
-- path. email_verification_tokens has RLS ON, so this pre-tenant lookup goes
-- through a SECURITY DEFINER resolver. It is advisory only: auth_verify_email is
-- the authority and re-checks under the per-user advisory lock.
CREATE OR REPLACE FUNCTION auth_peek_email_verification_token(p_token_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.user_id FROM email_verification_tokens t
  WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now();
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_peek_email_verification_token(text) FROM PUBLIC;--> statement-breakpoint

-- Atomic email verification for self-serve signup. The verify endpoint presents
-- a token hash before it has any tenant context, so this SECURITY DEFINER
-- function is the one audited bypass. It consumes the token, marks the user
-- verified, and burns sibling verification links in one transaction behind a
-- per-user advisory lock. Returns no row for unknown/expired/replayed tokens.
CREATE OR REPLACE FUNCTION auth_verify_email(p_token_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT t.user_id INTO v_user_id
  FROM email_verification_tokens t
  WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('auth_verify_email'), hashtext(v_user_id::text));

  UPDATE email_verification_tokens
  SET consumed_at = now()
  WHERE token_hash = p_token_hash AND consumed_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE users
  SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
  WHERE id = v_user_id;

  UPDATE email_verification_tokens t
  SET consumed_at = now()
  WHERE t.user_id = v_user_id AND t.consumed_at IS NULL;

  RETURN QUERY SELECT v_user_id;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_verify_email(text) FROM PUBLIC;
