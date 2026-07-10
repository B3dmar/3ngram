-- Atomic signup-token hardening (Codex P1).
--
-- A verification link verifies whichever password hash is currently stored, so
-- user creation, password replacement, stale-link burn, and fresh token minting
-- must not be split across app-side steps. These SECURITY DEFINER functions are
-- the audited pre-tenant boundary for self-serve signup token issuance.
--
-- Retry uses the SAME advisory-lock namespace as auth_verify_email so an old
-- link cannot verify concurrently while the retry swaps the password. The
-- expected-hash predicate preserves compare-and-swap behavior between competing
-- retry requests. Initial signup runs insert+token in one statement/transaction,
-- so no duplicate request can observe a tokenless unverified row.
CREATE OR REPLACE FUNCTION auth_create_unverified_signup(
  p_email text,
  p_password_hash text,
  p_token_hash text,
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

  INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
  VALUES (v_user_id, p_token_hash, p_expires_at);

  RETURN QUERY SELECT v_user_id;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_create_unverified_signup(text, text, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_retry_unverified_signup(
  p_user_id uuid,
  p_expected_password_hash text,
  p_new_password_hash text,
  p_token_hash text,
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

  INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
  VALUES (p_user_id, p_token_hash, p_expires_at);

  RETURN true;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_retry_unverified_signup(uuid, text, text, text, timestamp with time zone) FROM PUBLIC;
