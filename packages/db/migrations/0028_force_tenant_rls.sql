-- Tenant-isolation hardening: FORCE ROW LEVEL SECURITY on the memory/billing
-- tenant-data tables (defense in depth).
--
-- ENABLE ROW LEVEL SECURITY (0000/0015/0022/0023/0026) applies the
-- tenant_isolation policies to ordinary roles but NOT to the table owner:
-- if the runtime ever connected as the owner role (misconfigured connection
-- string, ad-hoc tooling), the policies would silently stop applying. FORCE
-- makes the owner subject to the policies too, so a wrong-role connection
-- fails closed instead of reading cross-tenant.
--
-- These 12 tables are reached only through withTenant() (src/client.ts), which
-- always binds app.user_id inside a transaction — forcing them changes nothing
-- for the app_user runtime role (already NOBYPASSRLS) and only removes the
-- owner-bypass path.
--
-- DELIBERATELY NOT FORCED — the six auth/token tables (api_keys, oauth_codes,
-- oauth_tokens, user_sessions, password_reset_tokens,
-- email_verification_tokens): the SECURITY DEFINER auth resolvers
-- (0003_auth_resolvers.sql, 0014_client_has_grants_resolver.sql,
-- 0015/0016/0017/0018/0019) are owned by the table owner and rely on
-- ENABLE-not-FORCE owner bypass to answer tenant-less credential lookups
-- (session/api-key/token resolution runs BEFORE any tenant context exists).
-- Forcing those tables would make every resolver fail closed and break login.
ALTER TABLE "commitments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consolidation_proposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_edges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budget_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profile_attributes" FORCE ROW LEVEL SECURITY;
