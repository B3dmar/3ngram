-- SPDX-License-Identifier: Apache-2.0
-- The ONLY place roles and GRANTs live (avoids repeating per-migration
-- role guards across many migrations; we centralize instead).
-- Idempotent. Run with the OWNER/unpooled connection during initial
-- provisioning and after migrations that create or replace app-used objects.
-- Password is set out-of-band: ALTER ROLE app_user PASSWORD '...' at provision time.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Re-assert NOBYPASSRLS on every provisioning run (defense in depth): the DO
-- block above only sets it when the role is first created.
ALTER ROLE app_user NOBYPASSRLS;

-- Baseline: nothing.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Identity. users + oauth_clients are system tables (no user_id); the rest
-- are RLS-enforced. Pre-tenant credential lookups go ONLY through the
-- SECURITY DEFINER resolvers (migrations/0003_auth_resolvers.sql).
GRANT SELECT, INSERT, UPDATE ON users, user_sessions, api_keys, oauth_clients, oauth_tokens TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_codes, user_sessions, password_reset_tokens, email_verification_tokens TO app_user; -- short-lived rows get cleaned up
GRANT SELECT, INSERT, UPDATE ON user_profile_attributes TO app_user; -- onboarding profiling, RLS-enforced; upsert, no DELETE
GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_resolve_api_key(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_resolve_oauth_token(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_consume_oauth_code(text) TO app_user;
-- SECURITY DEFINER existence check the registered-but-never-used client GC uses
-- to skip token/code-bearing clients (migrations/0015). The GC runs tenant-less,
-- so it cannot read the RLS-protected oauth_tokens/oauth_codes directly.
GRANT EXECUTE ON FUNCTION auth_client_has_grants(text) TO app_user;
-- Forgotten-password reset: the SECURITY DEFINER single-use consume resolver
-- (migrations/0015). The reset POST runs tenant-less (no current session), so it
-- cannot touch the RLS-protected password_reset_tokens table directly.
GRANT EXECUTE ON FUNCTION auth_consume_password_reset_token(text) TO app_user;
-- Atomic per-user-serialized reset (migrations/0016 takeover fix):
-- consumes the token, rotates the password, revokes all sessions, and burns
-- sibling tokens in ONE tx behind a per-user advisory lock. Tenant-less like the
-- consume resolver, so EXECUTE on the SECURITY DEFINER function is its only need.
GRANT EXECUTE ON FUNCTION auth_reset_password(text, text) TO app_user;
-- Cheap read-only token-validity check (migrations/0016) the reset route runs
-- BEFORE argon2 hashing so bogus tokens cannot burn CPU/memory (DoS hardening).
GRANT EXECUTE ON FUNCTION auth_peek_reset_token(text) TO app_user;
-- Email verification for self-serve signup mirrors password-reset: token lookup
-- and verification are tenant-less, so the SECURITY DEFINER functions are the
-- only pre-tenant access path into email_verification_tokens.
GRANT EXECUTE ON FUNCTION auth_peek_email_verification_token(text, text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_verify_email(text, text) TO app_user;
-- Self-serve signup token issuance must be atomic with user creation / password
-- replacement so stale links cannot verify a later password state.
GRANT EXECUTE ON FUNCTION auth_create_unverified_signup(text, text, text, text, timestamp with time zone) TO app_user;
GRANT EXECUTE ON FUNCTION auth_retry_unverified_signup(uuid, text, text, text, text, timestamp with time zone) TO app_user;
-- Resend serializes with the above via the auth_verify_email advisory
-- lock and re-checks live + verified state under it (0021).
GRANT EXECUTE ON FUNCTION auth_resend_email_verification(uuid, text, text, timestamp with time zone) TO app_user;

-- Memory domain (RLS-enforced; append-and-supersede => NO DELETE on memory data)
GRANT SELECT, INSERT, UPDATE ON memories, memory_edges, commitments, facts, consolidation_proposals, scopes TO app_user;

-- Scopes are a NAME/ALIAS REGISTRY, not memory data: deleting a scope row only
-- edits the registry (memories.scope is denormalized text with no FK, so a
-- deleted scope leaves memory rows untouched and valid). DELETE
-- is therefore granted on `scopes` ALONE; every memory-data table above stays
-- DELETE-denied (the append-only grant, asserted by the append-only suite).
GRANT DELETE ON scopes TO app_user;

-- oauth_clients DELETE is granted ALONE (not folded into line 21's SELECT/INSERT/
-- UPDATE) for the registered-but-never-used client GC: the
-- 30-day sweep deletes client rows that never minted a token.
GRANT DELETE ON oauth_clients TO app_user;

-- Append-only: INSERT and SELECT only. No UPDATE, no DELETE — immutability is a grant, not a convention.
GRANT SELECT, INSERT ON memory_events, audit_log TO app_user;

-- Ops
GRANT SELECT, INSERT ON llm_usage, eval_runs TO app_user;

-- Budget. user_budgets is an RLS-enforced tenant table: SELECT/INSERT/UPDATE, NO
-- DELETE (accounts retain their data — docs/concepts/data-model.mdx). plan_tiers is admin-managed
-- GLOBAL config: app_user reads the tier→cap for the budget resolver; writes are
-- admin-only (seeded by migration, edited via the owner/provisioning connection)
-- so a cap change is data, not code.
GRANT SELECT, INSERT, UPDATE ON user_budgets TO app_user;
GRANT SELECT ON plan_tiers TO app_user;
-- budget_reservations are transient in-flight spend holds (concurrency fix): the
-- gate INSERTs a reservation before a metered call and DELETEs it after, so this
-- table is MUTABLE — unlike the append-only llm_usage cost ledger.
GRANT SELECT, INSERT, DELETE ON budget_reservations TO app_user;
