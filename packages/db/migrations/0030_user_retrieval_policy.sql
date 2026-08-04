CREATE TABLE "user_retrieval_policy" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"default_scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_retrieval_policy_mode_check" CHECK ("user_retrieval_policy"."mode" IN ('off', 'default', 'require')),
	CONSTRAINT "user_retrieval_policy_scope_consistency_check" CHECK (("user_retrieval_policy"."mode" = 'default' AND "user_retrieval_policy"."default_scope" IS NOT NULL)
        OR ("user_retrieval_policy"."mode" <> 'default' AND "user_retrieval_policy"."default_scope" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "user_retrieval_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_retrieval_policy" ADD CONSTRAINT "user_retrieval_policy_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_retrieval_policy" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028 precedent): FORCE so the tenant_isolation
-- policy also binds the table owner — this table is reached only through
-- withTenant(), and a wrong-role connection must fail closed, never read
-- cross-tenant. app_user is NOBYPASSRLS either way; FORCE removes the
-- owner-bypass path.
ALTER TABLE "user_retrieval_policy" FORCE ROW LEVEL SECURITY;