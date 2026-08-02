-- Tenant-isolation hardening: RLS on audit_log (defense in depth).
--
-- audit_log carries a user_id but had no policy while app_user holds SELECT
-- (provision-roles.sql), so tenant-scoped code could read across tenants.
--
-- The policy differs from the standard tenant_isolation shape on purpose:
-- audit_log is written tenant-less via getAdminDb() (src/audit-log.ts) and
-- system rows (pre-auth OAuth events) carry a NULL user_id, so the standard
-- `user_id = app.user_id` USING/WITH CHECK would reject the entire existing
-- insert path. This variant keeps the tenant-less system path open (no
-- app.user_id bound => full access, the same trust boundary getAdminDb()
-- already represents) and pins any tenant-bound transaction (withTenant())
-- to its own rows. Declared in src/schema/ops.ts so drizzle-kit tracks it.
--
-- ENABLE (not FORCE): consistent with the auth tables, owner-side maintenance
-- and the migration connection stay unaffected; app_user is NOBYPASSRLS so the
-- policy binds the runtime either way.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO public USING (NULLIF(current_setting('app.user_id', true), '') IS NULL OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (NULLIF(current_setting('app.user_id', true), '') IS NULL OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
