CREATE TABLE "plan_tiers" (
	"tier" text PRIMARY KEY NOT NULL,
	"cap_usd" numeric(20, 12) NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_tiers_tier_check" CHECK ("plan_tiers"."tier" IN ('free', 'pro', 'team'))
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"grandfathered" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tier_check" CHECK ("subscriptions"."tier" IN ('free', 'pro', 'team')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" IN ('trialing', 'active', 'grace', 'suspended', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_budgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"cap_usd_override" numeric(20, 12),
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_budgets" ADD CONSTRAINT "user_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_tiers_tier_idx" ON "plan_tiers" USING btree ("tier");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_events_event_id_idx" ON "stripe_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_budgets_user_idx" ON "user_budgets" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscriptions" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_budgets" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Seed plan_tiers: tier→budget-cap config, editable as DATA so a
-- cap change needs no code deploy. cap_usd is the per-cycle LLM SPEND ceiling
-- (Apache budget machinery) — NOT the subscription price (Stripe prices live
-- in FSL env/config). Values are operational placeholders; tune as data via
-- plan_tiers, no migration required. ON CONFLICT keeps re-runs idempotent.
INSERT INTO "plan_tiers" ("tier", "cap_usd", "capabilities") VALUES
	('free', 1.000000000000, '{}'::jsonb),
	('pro', 50.000000000000, '{}'::jsonb),
	('team', 200.000000000000, '{}'::jsonb)
ON CONFLICT ("tier") DO NOTHING;
