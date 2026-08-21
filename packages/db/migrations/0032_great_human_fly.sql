CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"source" text NOT NULL,
	"project" text,
	"scope" text,
	"selector" jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activation_epoch" integer DEFAULT 1 NOT NULL,
	"triage_status" text DEFAULT 'idle' NOT NULL,
	"triage_attempt_id" uuid,
	"last_triaged_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"briefing_delivered_at" timestamp with time zone,
	"briefed_memories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_message_excerpt" text,
	CONSTRAINT "agent_sessions_tenant_id_uq" UNIQUE("user_id","id"),
	CONSTRAINT "agent_sessions_natural_key" UNIQUE("user_id","agent","session_id"),
	CONSTRAINT "agent_sessions_source_check" CHECK ("agent_sessions"."source" IN ('startup', 'resume')),
	CONSTRAINT "agent_sessions_triage_check" CHECK ("agent_sessions"."triage_status" IN ('idle', 'pending', 'completed', 'expired', 'overflowed'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_lease_idx" ON "agent_sessions" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "memory_events_session_idx" ON "memory_events" USING btree ("user_id",("payload"->>'sessionRunId'),"id") WHERE "memory_events"."payload"->>'sessionRunId' IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_sessions" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Tenant-isolation hardening (0028/0031 precedent): FORCE so the tenant_isolation
-- policy also binds the table owner. Reached only through withTenant().
ALTER TABLE "agent_sessions" FORCE ROW LEVEL SECURITY;