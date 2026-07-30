ALTER TABLE "oauth_clients" ADD COLUMN "registration_method" text DEFAULT 'dynamic_registration' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_registration_method_check" CHECK ("oauth_clients"."registration_method" IN ('dynamic_registration', 'client_id_metadata'));
