CREATE TABLE "user_judgment_policy" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_judgment_policy_mode_check" CHECK ("user_judgment_policy"."mode" IN ('off', 'on'))
);
--> statement-breakpoint
ALTER TABLE "user_judgment_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_judgment_policy" ADD CONSTRAINT "user_judgment_policy_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_judgment_policy" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028/0030/0039 precedent): FORCE so the
-- tenant_isolation policy also binds the table owner. This table is reached
-- only through withTenant(), and a wrong-role connection must fail closed.
ALTER TABLE "user_judgment_policy" FORCE ROW LEVEL SECURITY;
