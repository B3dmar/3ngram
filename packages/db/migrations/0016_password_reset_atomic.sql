-- Atomic, per-user-serialized forgotten-password reset
-- (account-takeover hardening). Supersedes the consume->read->rotate split that
-- left a concurrency TOCTOU: resetPassword() consumed the presented token in one
-- transaction and rotated the password in a separate one, so a second live reset
-- link for the same user could be consumed in the race window (escaping the
-- sibling purge) and then rotate the freshly-reset password after reading the
-- new hash — a stale sibling acting as an account-takeover credential.
--
-- The whole reset now runs in ONE transaction behind a per-user advisory lock.
-- password_reset_tokens has RLS ON, so like auth_consume_password_reset_token
-- (0015) this is a SECURITY DEFINER resolver — the one narrow audited pre-tenant
-- path. The function owner (the migration role) owns users / user_sessions /
-- password_reset_tokens and bypasses their RLS; app_user (NOBYPASSRLS) only ever
-- gets EXECUTE. There is NO app.user_id GUC inside the function, so every
-- statement is scoped by an explicit user_id / id predicate — never lean on a
-- tenant policy here. search_path is pinned (SECURITY DEFINER hygiene).
--
-- WHY THE ADVISORY LOCK: serializing all resets for one user means exactly one
-- can take effect. The winner consumes its token, rotates, revokes every session,
-- and burns every other unconsumed token; any concurrent loser blocks on the lock
-- and then finds its token already burned (consume re-check returns no row). It
-- also avoids an A<->B deadlock between the sibling-burn and the users-row UPDATE
-- that a lock-free single-tx version would hit (each tx holds one row and waits
-- for the other). The two-arg form reserves a private namespace in the shared
-- 64-bit advisory space so a future advisory lock cannot collide with this one.
--
-- The new password is argon2-hashed APP-SIDE; only the hash is passed in (the
-- plaintext never reaches SQL, mirroring the token_hash contract). Returns the
-- user_id on success, or NO ROW for an unknown/expired/already-consumed token —
-- the caller maps an empty result to a single InvalidResetTokenError (no
-- enumeration). There is deliberately NO compare-and-swap on the old password
-- hash: authority is holding a valid, unconsumed token under the per-user lock,
-- not knowledge of the prior hash (the old CAS is exactly what the TOCTOU
-- defeated). Never log the token hash or either password (hard rule 6).
--
-- EXECUTE is REVOKED from PUBLIC here; the app_user grant lives in
-- scripts/provision-roles.sql (a grant in the migration aborts a fresh self-host
-- where app_user does not yet exist fresh-install lesson).
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
  -- app.user_id, so these predicates are the SOLE tenant boundary. Table columns
  -- are alias-qualified because RETURNS TABLE(user_id ...) puts an OUT variable
  -- named user_id in scope — a bare `user_id` would be ambiguous (42702).
  UPDATE users SET password_hash = p_new_password_hash WHERE id = v_user_id;
  DELETE FROM user_sessions s WHERE s.user_id = v_user_id; -- revoke ALL sessions
  UPDATE password_reset_tokens t
  SET consumed_at = now()
  WHERE t.user_id = v_user_id AND t.consumed_at IS NULL; -- burn ALL sibling tokens

  RETURN QUERY SELECT v_user_id;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_reset_password(text, text) FROM PUBLIC;--> statement-breakpoint

-- Cheap read-only validity check used BEFORE the expensive argon2id hash on the
-- reset path (DoS hardening). /auth/reset-password is unauthenticated
-- and the per-IP limiter fails open on store errors, so hashing every presented
-- token would let bogus tokens burn ~19 MiB + CPU per request without owning a
-- reset link. password_reset_tokens has RLS ON, so this pre-tenant lookup goes
-- through a SECURITY DEFINER resolver like the consume path. It is ADVISORY only:
-- a token valid here may be consumed by a concurrent reset before the caller
-- reaches auth_reset_password, whose under-lock re-check is the SOLE authority —
-- a false-positive peek just means the atomic call returns no row and the caller
-- raises InvalidResetTokenError. Never log the hash (hard rule 6).
CREATE OR REPLACE FUNCTION auth_peek_reset_token(p_token_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.user_id FROM password_reset_tokens t
  WHERE t.token_hash = p_token_hash AND t.consumed_at IS NULL AND t.expires_at > now();
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_peek_reset_token(text) FROM PUBLIC;
