-- Resend-verification must serialize with the signup retry/verify paths
-- . The prior resend helper
-- (replaceEmailVerificationTokens) ran a bare supersede+mint CTE inside
-- withTenant() and took NO advisory lock, so it was the ONE mutator of
-- email_verification_tokens + users.email_verified_at that did not serialize
-- against auth_verify_email / auth_create_unverified_signup /
-- auth_retry_unverified_signup. Under READ COMMITTED its single-statement
-- snapshot could observe a still-live token for the caller's proof AFTER a
-- racing retry had already consumed it and replaced the password — minting a
-- fresh link bound to the stale proof. Clicking that link verifies the account
-- under the OTHER party's password (takeover), reopening the exact hole the
-- proof-continuity check was meant to close.
--
-- Move the supersede+mint into a SECURITY DEFINER resolver that takes the SAME
-- per-user advisory lock as the sibling mutators and re-checks live + verified
-- state UNDER the lock before minting. As definer it owns the tables (created in
-- 0000), so it bypasses RLS without an app.user_id GUC — sidestepping the 42501
-- WITH CHECK failure that forced the tenant-scoped revert in b8d5bf9; explicit
-- p_user_id scoping is the sole tenant boundary. Pinned search_path. Never log
-- the token hash, proof, or email (hard rule 6).
--
-- Semantics preserved from the prior CTE: "live" = an UNCONSUMED token exists
-- for (user_id, client_proof_hash) — expiry is intentionally NOT part of the
-- continuity check (a fresh expiry is minted anyway); supersede deletes the
-- caller's same-proof links only; mint nothing (RETURN false) otherwise. Added
-- under the lock: a verified-account gate, so a resend that races verification
-- mints no link that could outlive it (closes the residual re-verify race
-- b8d5bf9 deferred).
CREATE OR REPLACE FUNCTION auth_resend_email_verification(
  p_user_id uuid,
  p_token_hash text,
  p_client_proof_hash text,
  p_expires_at timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Serialize every signup-token mutation for this user. Held to commit.
  PERFORM pg_advisory_xact_lock(hashtext('auth_verify_email'), hashtext(p_user_id::text));

  -- Verified-account gate (under the lock): once verified, the verify resolver
  -- has consumed the tokens; a resend must not re-introduce a live link.
  IF NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = p_user_id AND u.email_verified_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  -- Proof continuity (re-checked UNDER the lock): the caller's proof must still
  -- own an unconsumed token. A racing retry that consumed it (and replaced the
  -- password) leaves nothing here, so we mint nothing — no stale-proof link can
  -- verify the account under the competing signup's password.
  IF NOT EXISTS (
    SELECT 1 FROM email_verification_tokens t
    WHERE t.user_id = p_user_id
      AND t.client_proof_hash = p_client_proof_hash
      AND t.consumed_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  -- Supersede the caller's prior same-proof links, then mint the fresh one.
  DELETE FROM email_verification_tokens t
  WHERE t.user_id = p_user_id AND t.client_proof_hash = p_client_proof_hash;

  INSERT INTO email_verification_tokens (user_id, token_hash, client_proof_hash, expires_at)
  VALUES (p_user_id, p_token_hash, p_client_proof_hash, p_expires_at);

  RETURN true;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_resend_email_verification(uuid, text, text, timestamp with time zone) FROM PUBLIC;
