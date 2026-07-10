-- Pre-tenant credential resolution (review follow-up).
-- RLS is ON for user_sessions/api_keys/oauth_codes/oauth_tokens; these
-- SECURITY DEFINER functions are the ONLY pre-tenant access path — one
-- narrow, audited lookup per credential type, owned by the migration role
-- (which owns the tables and therefore bypasses their RLS).
-- search_path is pinned (SECURITY DEFINER hygiene). EXECUTE is revoked from
-- PUBLIC here; the app_user grant lives in scripts/provision-roles.sql.

CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id, expires_at FROM user_sessions
  WHERE token_hash = p_token_hash AND expires_at > now();
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_resolve_api_key(p_key_hash text)
RETURNS TABLE (user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id FROM api_keys
  WHERE key_hash = p_key_hash AND revoked_at IS NULL;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_resolve_oauth_token(p_token_hash text)
RETURNS TABLE (user_id uuid, client_id text, kind text, scope text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id, client_id, kind, scope, expires_at FROM oauth_tokens
  WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
$$;--> statement-breakpoint

-- Atomic single-use consumption: marks the code used and returns its grant.
CREATE OR REPLACE FUNCTION auth_consume_oauth_code(p_code_hash text)
RETURNS TABLE (user_id uuid, client_id text, redirect_uri text, code_challenge text, scope text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE oauth_codes SET used_at = now()
  WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id, client_id, redirect_uri, code_challenge, scope;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_resolve_api_key(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_resolve_oauth_token(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_consume_oauth_code(text) FROM PUBLIC;
