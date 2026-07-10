-- Credential-resurrection guard for the forgotten-password resolver.
-- The 0020 resolver rotated
-- users.password_hash by id WITHOUT checking the deletion tombstone, so a reset
-- validated just before an account deletion could set a REAL hash AFTER the
-- tombstone and re-enable login to a deleted account.
--
-- This CREATE OR REPLACE keeps the entire 0020 contract (one transaction, the
-- per-user auth_reset_password advisory lock, SECURITY DEFINER, explicit user_id
-- scoping, pinned search_path, full credential revocation) and adds ONE check:
-- after consuming the token UNDER the lock, refuse (no-op return) when the user
-- row is a deletion tombstone. Account deletion takes this SAME advisory lock and
-- burns the reset tokens, so the two serialize — this check is the in-resolver
-- backstop that makes the function correct even in isolation. The marker matches
-- packages/db/src/account-delete.ts: email = deleted-<id>@deleted.invalid OR
-- password_hash = '!erased'. Never log the token hash or either password (rule 6).
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

  -- Refuse to set a password on a tombstoned account. Deletion takes
  -- this SAME advisory lock, so this read cannot race a not-yet-committed
  -- deletion; the token is already consumed above, so a deleted account simply
  -- yields no password change (caller raises InvalidResetTokenError, no oracle).
  PERFORM 1 FROM users u
  WHERE u.id = v_user_id
    AND (u.email = 'deleted-' || v_user_id::text || '@deleted.invalid'
         OR u.password_hash = '!erased');
  IF FOUND THEN
    RETURN;
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
