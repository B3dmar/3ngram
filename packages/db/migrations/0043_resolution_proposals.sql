CREATE TABLE "resolution_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"session_run_id" uuid NOT NULL,
	"probability" double precision NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolution_proposals_status_check" CHECK ("resolution_proposals"."status" IN ('proposed', 'applied', 'rejected')),
	CONSTRAINT "resolution_proposals_probability_check" CHECK ("resolution_proposals"."probability" >= 0 AND "resolution_proposals"."probability" <= 1)
);
--> statement-breakpoint
ALTER TABLE "resolution_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_session_fk" FOREIGN KEY ("user_id","session_run_id") REFERENCES "public"."agent_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_proposals_open_idx" ON "resolution_proposals" USING btree ("user_id","memory_id") WHERE status = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_proposals_run_memory_uq" ON "resolution_proposals" USING btree ("user_id","session_run_id","memory_id");--> statement-breakpoint
CREATE INDEX "resolution_proposals_review_idx" ON "resolution_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "resolution_proposals" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028/0030/0039/0042 precedent): FORCE so the
-- tenant_isolation policy also binds the table owner. This table is reached
-- only through withTenant(), and a wrong-role connection must fail closed.
ALTER TABLE "resolution_proposals" FORCE ROW LEVEL SECURITY;
