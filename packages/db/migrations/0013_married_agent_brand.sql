ALTER TABLE "oauth_codes" ADD COLUMN "redirect_uri_supplied" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- RFC 6749 §4.1.3: the consume resolver must surface the new
-- redirect_uri_supplied bit so the token endpoint can enforce "redirect_uri is
-- REQUIRED at token iff it was supplied at /authorize". The RETURNS TABLE row
-- type changes (new column), and PostgreSQL cannot alter a function's result
-- type with CREATE OR REPLACE — so DROP then CREATE. Re-port every attribute and
-- ACL from 0003_auth_resolvers.sql verbatim: SECURITY DEFINER, the pinned
-- search_path, and the REVOKE ALL ... FROM PUBLIC (the app_user grant lives in
-- scripts/provision-roles.sql and is unaffected). The atomic single-use guard
-- (used_at IS NULL) is preserved exactly.
DROP FUNCTION IF EXISTS auth_consume_oauth_code(text);--> statement-breakpoint
CREATE FUNCTION auth_consume_oauth_code(p_code_hash text)
RETURNS TABLE (user_id uuid, client_id text, redirect_uri text, redirect_uri_supplied boolean, code_challenge text, scope text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE oauth_codes SET used_at = now()
  WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id, client_id, redirect_uri, redirect_uri_supplied, code_challenge, scope;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_consume_oauth_code(text) FROM PUBLIC;
