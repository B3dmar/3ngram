-- Account-recovery reset must revoke EVERY issued credential, not just browser
-- sessions.
-- The 0016 resolver rotated the password, deleted user_sessions, and
-- burned sibling reset tokens — but left the user's OAuth access/refresh tokens
-- and API keys live, so a stolen agent credential survived "reset my password".
--
-- This CREATE OR REPLACE keeps the whole 0016 contract (one transaction, per-user
-- advisory lock, SECURITY DEFINER, explicit user_id scoping as the sole tenant
-- boundary, no app.user_id GUC, pinned search_path) and adds agent-credential
-- revocation. Tokens are SOFT-revoked (revoked_at = now()) — the resolvers
-- (auth_resolve_oauth_token / auth_resolve_api_key, 0003) already filter
-- `revoked_at IS NULL`, so a soft revoke is fully effective while preserving
-- rotation/audit history (sessions stay hard-deleted — user_sessions has no
-- revoked_at column). The definer owns oauth_tokens / api_keys (created in 0000),
-- so it bypasses their RLS here; columns are alias-qualified because the
-- RETURNS TABLE(user_id ...) OUT variable would otherwise make a bare `user_id`
-- ambiguous (42702). Never log the token hash or either password (hard rule 6).
CREATE OR REPLACE FUNCTION auth_reset_password(p_token_hash text, p_new_password_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Peek (no consume) to learn the owner of a still-valid token. Racy by
  -- design: used only to choose the advisory key — the authority is the
  -- post-lock re-check+consume below.
  SELECT t.user_id INTO v_user_id
  FROM password_reset_tokens t
  WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now();
  IF v_user_id IS NULL THEN
    RETURN; -- no row -> caller raises InvalidResetTokenError
  END IF;

  -- Serialize every reset for this user. Held to commit (xact lock).
  PERFORM pg_advisory_xact_lock(hashtext('auth_reset_password'), hashtext(v_user_id::text));

  -- Re-check + consume the presented token UNDER the lock (expiry filter MUST
  -- stay aligned with the peek above). A concurrent reset that already won will
  -- have burned this token, so this matches zero rows and we bail.
  UPDATE password_reset_tokens
  SET consumed_at = now()
  WHERE token_hash = p_token_hash AND consumed_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN
    RETURN; -- raced and lost -> InvalidResetTokenError
  END IF;

  -- Explicit user_id / id scoping: the definer bypasses RLS and sets no
  -- app.user_id, so these predicates are the SOLE tenant boundary.
  UPDATE users SET password_hash = p_new_password_hash WHERE id = v_user_id;
  DELETE FROM user_sessions s WHERE s.user_id = v_user_id; -- revoke ALL sessions
  -- Revoke ALL issued agent credentials — soft revoke, resolvers honor it.
  UPDATE oauth_tokens t SET revoked_at = now()
  WHERE t.user_id = v_user_id AND t.revoked_at IS NULL; -- OAuth access + refresh
  UPDATE api_keys k SET revoked_at = now()
  WHERE k.user_id = v_user_id AND k.revoked_at IS NULL; -- headless API keys
  UPDATE password_reset_tokens t
  SET consumed_at = now()
  WHERE t.user_id = v_user_id AND t.consumed_at IS NULL; -- burn ALL sibling tokens

  RETURN QUERY SELECT v_user_id;
END;
$$;--> statement-breakpoint
