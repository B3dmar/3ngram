CREATE TABLE "retention_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"action" text NOT NULL,
	"related_memory_id" uuid,
	"probability" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_proposals_action_check" CHECK ("retention_proposals"."action" IN ('keep', 'archive', 'supersede', 'conflict')),
	CONSTRAINT "retention_proposals_status_check" CHECK ("retention_proposals"."status" IN ('proposed', 'applied', 'rejected', 'dismissed')),
	CONSTRAINT "retention_proposals_probability_check" CHECK ("retention_proposals"."probability" >= 0 AND "retention_proposals"."probability" <= 1),
	CONSTRAINT "retention_proposals_related_check" CHECK (("retention_proposals"."action" IN ('supersede', 'conflict')) = ("retention_proposals"."related_memory_id" IS NOT NULL)),
	CONSTRAINT "retention_proposals_distinct_check" CHECK ("retention_proposals"."related_memory_id" IS NULL OR "retention_proposals"."related_memory_id" <> "retention_proposals"."memory_id")
);
--> statement-breakpoint
ALTER TABLE "retention_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_proposals" ADD CONSTRAINT "retention_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_proposals" ADD CONSTRAINT "retention_proposals_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_proposals" ADD CONSTRAINT "retention_proposals_related_memory_fk" FOREIGN KEY ("user_id","related_memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_proposals_open_idx" ON "retention_proposals" USING btree ("user_id","memory_id","action") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "retention_proposals_review_idx" ON "retention_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retention_proposals" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028/0030/0039/0042/0043/0044 precedent): FORCE so
-- the tenant_isolation policy also binds the table owner. This table is reached
-- only through withTenant(), and a wrong-role connection must fail closed.
ALTER TABLE "retention_proposals" FORCE ROW LEVEL SECURITY;
