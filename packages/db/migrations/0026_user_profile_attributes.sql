CREATE TABLE "user_profile_attributes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" text,
	"use_case" text,
	"ai_tools" text[],
	"referral_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profile_attributes_role_check" CHECK ("user_profile_attributes"."role" IN ('engineer', 'founder', 'product', 'researcher', 'other')),
	CONSTRAINT "user_profile_attributes_use_case_check" CHECK ("user_profile_attributes"."use_case" IN ('personal', 'team', 'dev', 'research', 'other')),
	CONSTRAINT "user_profile_attributes_referral_source_check" CHECK ("user_profile_attributes"."referral_source" IN ('reddit', 'twitter', 'colleague', 'search', 'other'))
);
--> statement-breakpoint
ALTER TABLE "user_profile_attributes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profile_attributes" ADD CONSTRAINT "user_profile_attributes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_profile_attributes" AS PERMISSIVE FOR ALL TO public USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);