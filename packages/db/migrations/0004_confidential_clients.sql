ALTER TABLE "oauth_clients" ADD COLUMN "token_endpoint_auth_method" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "client_secret_hash" text;