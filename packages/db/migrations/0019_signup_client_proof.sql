ALTER TABLE "email_verification_tokens" ADD COLUMN "client_proof_hash" text;--> statement-breakpoint
UPDATE "email_verification_tokens"
SET "client_proof_hash" = repeat('0', 64)
WHERE "client_proof_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ALTER COLUMN "client_proof_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_client_proof_hash_check" CHECK ("email_verification_tokens"."client_proof_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- Browser/client proof binding (Codex P2): a mailbox-only verification
-- click must not activate a password chosen by a different requester. The email
-- token and the signup proof are both high-entropy client secrets; the DB stores
-- only their SHA-256 hashes and verification requires BOTH.
DROP FUNCTION IF EXISTS auth_peek_email_verification_token(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_verify_email(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_create_unverified_signup(text, text, text, timestamp with time zone);--> statement-breakpoint
DROP FUNCTION IF EXISTS auth_retry_unverified_signup(uuid, text, text, text, timestamp with time zone);--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_peek_email_verification_token(
  p_token_hash text,
  p_client_proof_hash text
)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.user_id FROM email_verification_tokens t
  WHERE t.token_hash = p_token_hash
    AND t.client_proof_hash = p_client_proof_hash
    AND t.consumed_at IS NULL
    AND t.expires_at > now();
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_peek_email_verification_token(text, text) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_verify_email(
  p_token_hash text,
  p_client_proof_hash text
)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT t.user_id INTO v_user_id
  FROM email_verification_tokens t
  WHERE t.token_hash = p_token_hash
    AND t.client_proof_hash = p_client_proof_hash
    AND t.consumed_at IS NULL
    AND t.expires_at > now();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('auth_verify_email'), hashtext(v_user_id::text));

  UPDATE email_verification_tokens
  SET consumed_at = now()
  WHERE token_hash = p_token_hash
    AND client_proof_hash = p_client_proof_hash
    AND consumed_at IS NULL
    AND expires_at > now();
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

REVOKE ALL ON FUNCTION auth_verify_email(text, text) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_create_unverified_signup(
  p_email text,
  p_password_hash text,
  p_token_hash text,
  p_client_proof_hash text,
  p_expires_at timestamp with time zone
)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  INSERT INTO users (email, password_hash, email_verified_at)
  VALUES (p_email, p_password_hash, NULL)
  RETURNING id INTO v_user_id;

  PERFORM pg_advisory_xact_lock(hashtext('auth_verify_email'), hashtext(v_user_id::text));

  INSERT INTO email_verification_tokens (user_id, token_hash, client_proof_hash, expires_at)
  VALUES (v_user_id, p_token_hash, p_client_proof_hash, p_expires_at);

  RETURN QUERY SELECT v_user_id;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_create_unverified_signup(text, text, text, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_retry_unverified_signup(
  p_user_id uuid,
  p_expected_password_hash text,
  p_new_password_hash text,
  p_token_hash text,
  p_client_proof_hash text,
  p_expires_at timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('auth_verify_email'), hashtext(p_user_id::text));

  UPDATE users u
  SET password_hash = p_new_password_hash, updated_at = now()
  WHERE u.id = p_user_id
    AND u.password_hash = p_expected_password_hash
    AND u.email_verified_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE email_verification_tokens t
  SET consumed_at = now()
  WHERE t.user_id = p_user_id AND t.consumed_at IS NULL;

  INSERT INTO email_verification_tokens (user_id, token_hash, client_proof_hash, expires_at)
  VALUES (p_user_id, p_token_hash, p_client_proof_hash, p_expires_at);

  RETURN true;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_retry_unverified_signup(uuid, text, text, text, text, timestamp with time zone) FROM PUBLIC;
