CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner" text,
	"due_at" timestamp with time zone,
	"recurrence" jsonb,
	"next_surfacing_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_status_check" CHECK ("commitments"."status" IN ('open', 'waiting', 'resolved', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "commitments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consolidation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"memory_type" text NOT NULL,
	"similarity" real NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_edge_check" CHECK ("consolidation_proposals"."edge_type" IN ('supersedes', 'updates', 'extends', 'derives')),
	CONSTRAINT "proposals_type_check" CHECK ("consolidation_proposals"."memory_type" IN ('decision', 'commitment', 'blocker', 'fact', 'preference', 'pattern', 'note', 'event')),
	CONSTRAINT "proposals_status_check" CHECK ("consolidation_proposals"."status" IN ('proposed', 'applied', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "consolidation_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"confidence" real,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_validity_check" CHECK ("facts"."valid_to" IS NULL OR "facts"."valid_from" <= "facts"."valid_to")
);
--> statement-breakpoint
ALTER TABLE "facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_type" text NOT NULL,
	"topic" text NOT NULL,
	"content" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"project" text,
	"status" text DEFAULT 'active' NOT NULL,
	"embedding" vector(1536),
	"content_hash" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_tenant_id_uq" UNIQUE("user_id","id"),
	CONSTRAINT "memories_type_check" CHECK ("memories"."memory_type" IN ('decision', 'commitment', 'blocker', 'fact', 'preference', 'pattern', 'note', 'event')),
	CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('active', 'archived')),
	CONSTRAINT "memories_validity_check" CHECK ("memories"."valid_to" IS NULL OR "memories"."valid_from" <= "memories"."valid_to")
);
--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_edges_no_self_check" CHECK ("memory_edges"."from_id" <> "memory_edges"."to_id"),
	CONSTRAINT "memory_edges_type_check" CHECK ("memory_edges"."edge_type" IN ('supersedes', 'updates', 'extends', 'derives')),
	CONSTRAINT "memory_edges_actor_check" CHECK ("memory_edges"."created_by" IN ('user_dashboard', 'user_api', 'user_mcp', 'capture_hook', 'worker', 'importer', 'system'))
);
--> statement-breakpoint
ALTER TABLE "memory_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_events_kind_check" CHECK ("memory_events"."event_kind" IN ('create', 'revise', 'supersede', 'resolve', 'unresolve', 'archive', 'import')),
	CONSTRAINT "memory_events_actor_check" CHECK ("memory_events"."actor_kind" IN ('user_dashboard', 'user_api', 'user_mcp', 'capture_hook', 'worker', 'importer', 'system'))
);
--> statement-breakpoint
ALTER TABLE "memory_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"resource" text,
	"ip" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_check" CHECK ("audit_log"."actor_kind" IN ('user_dashboard', 'user_api', 'user_mcp', 'capture_hook', 'worker', 'importer', 'system'))
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"suite" text NOT NULL,
	"slice" text NOT NULL,
	"score" real NOT NULL,
	"git_sha" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_proposals" ADD CONSTRAINT "consolidation_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_proposals" ADD CONSTRAINT "proposals_from_fk" FOREIGN KEY ("user_id","from_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_proposals" ADD CONSTRAINT "proposals_to_fk" FOREIGN KEY ("user_id","to_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_from_fk" FOREIGN KEY ("user_id","from_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_to_fk" FOREIGN KEY ("user_id","to_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_memory_fk" FOREIGN KEY ("user_id","memory_id") REFERENCES "public"."memories"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_user_client_idx" ON "oauth_tokens" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_rotation_idx" ON "oauth_tokens" USING btree ("rotated_from") WHERE rotated_from IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_memory_idx" ON "commitments" USING btree ("user_id","memory_id");--> statement-breakpoint
CREATE INDEX "commitments_surfacing_idx" ON "commitments" USING btree ("user_id","status","next_surfacing_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_open_idx" ON "consolidation_proposals" USING btree ("user_id","from_id","to_id","edge_type") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "proposals_review_idx" ON "consolidation_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "facts_subject_idx" ON "facts" USING btree ("user_id","subject","predicate");--> statement-breakpoint
CREATE INDEX "memories_type_idx" ON "memories" USING btree ("user_id","memory_type");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("user_id","scope","status");--> statement-breakpoint
CREATE INDEX "memories_hash_idx" ON "memories" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_edges_unique_idx" ON "memory_edges" USING btree ("user_id","from_id","to_id","edge_type");--> statement-breakpoint
CREATE INDEX "memory_events_memory_idx" ON "memory_events" USING btree ("user_id","memory_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scopes_name_idx" ON "scopes" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "audit_log_user_time_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_suite_idx" ON "eval_runs" USING btree ("suite","slice","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_user_time_idx" ON "llm_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commitments" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consolidation_proposals" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "facts" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memories" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_edges" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_events" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "scopes" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "llm_usage" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);