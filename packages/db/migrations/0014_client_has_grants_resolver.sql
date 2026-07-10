-- GC data-loss guard: a SECURITY DEFINER existence check for "does this client
-- have a real grant" — any oauth_tokens row, or a LIVE (unused, unexpired)
-- oauth_codes row.
--
-- WHY A RESOLVER, NOT A PLAIN SUBQUERY: the registered-but-never-used client GC
-- runs as app_user (the runtime role, NOBYPASSRLS) with NO tenant context —
-- oauth_clients is a pre-auth system table, so the GC never sets app.user_id.
-- oauth_tokens and oauth_codes are RLS-protected (0002_auth_rls.sql,
-- tenant_isolation USING user_id = current_setting('app.user_id')). A bare
-- `NOT EXISTS (SELECT 1 FROM oauth_tokens ...)` in the GC query therefore sees
-- ZERO rows for every client (RLS fails closed with no tenant), so the guard
-- would silently never fire and a token-bearing client could still be hard-
-- DELETEd — CASCADE-orphaning a real user's grant. RLS on these tables is
-- ENABLE but not FORCE, so a SECURITY DEFINER function owned by the table owner
-- bypasses it and can answer the cross-tenant existence question, exactly like
-- the auth_consume/auth_resolve_* resolvers (0003_auth_resolvers.sql).
--
-- WHAT COUNTS AS A GRANT: any oauth_tokens row is authoritative (a minted token
-- is a real, durable grant). For oauth_codes, only a LIVE pending code blocks
-- GC: `used_at IS NULL AND expires_at > now()`. An authorization code is a
-- ~60s single-use artifact; a client that hit /authorize but never exchanged
-- leaves an expired, unused code that no cleanup job removes, and a stale
-- abandoned code must NOT keep that client out of the 30-day GC forever.
--
-- Returns true iff the client has at least one token OR one live pending code.
-- SECURITY DEFINER + a pinned search_path mirror the existing auth resolvers;
-- only the boolean answer leaves the function (no user/token material). EXECUTE
-- is REVOKEd from PUBLIC here; the app_user grant lives in
-- scripts/provision-roles.sql (run post-migrate), mirroring 0003_auth_resolvers
-- exactly — grants never live in migrations, so a fresh-install
-- migrate that precedes role provisioning never references an absent app_user.
CREATE OR REPLACE FUNCTION auth_client_has_grants(p_client_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = p_client_id)
      OR EXISTS (
        SELECT 1 FROM oauth_codes
        WHERE client_id = p_client_id
          AND used_at IS NULL
          AND expires_at > now()
      );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_client_has_grants(text) FROM PUBLIC;
