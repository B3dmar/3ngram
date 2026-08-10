CREATE TABLE "fact_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"confidence" real,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"memory_type" text NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_proposals_type_check" CHECK ("fact_proposals"."memory_type" IN ('decision', 'commitment', 'blocker', 'fact', 'preference', 'pattern', 'note', 'event')),
	CONSTRAINT "fact_proposals_status_check" CHECK ("fact_proposals"."status" IN ('proposed', 'applied', 'rejected')),
	CONSTRAINT "fact_proposals_validity_check" CHECK ("fact_proposals"."valid_to" IS NULL OR "fact_proposals"."valid_from" <= "fact_proposals"."valid_to")
);
--> statement-breakpoint
ALTER TABLE "fact_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fact_proposals" ADD CONSTRAINT "fact_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_proposals" ADD CONSTRAINT "fact_proposals_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_proposals_open_idx" ON "fact_proposals" USING btree ("user_id","memory_id","subject","predicate","value") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "fact_proposals_review_idx" ON "fact_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fact_proposals" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028 precedent): FORCE so the tenant_isolation
-- policy also binds the table owner. This table is reached only through
-- withTenant(), and a wrong-role connection must fail closed.
ALTER TABLE "fact_proposals" FORCE ROW LEVEL SECURITY;
