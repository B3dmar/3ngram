ALTER TABLE "memory_edges" DROP CONSTRAINT "memory_edges_actor_check";--> statement-breakpoint
ALTER TABLE "memory_events" DROP CONSTRAINT "memory_events_actor_check";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_check";--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_actor_check" CHECK ("memory_edges"."created_by" IN ('user_dashboard', 'user_api', 'user_mcp', 'worker', 'importer', 'system'));--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_actor_check" CHECK ("memory_events"."actor_kind" IN ('user_dashboard', 'user_api', 'user_mcp', 'worker', 'importer', 'system'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_check" CHECK ("audit_log"."actor_kind" IN ('user_dashboard', 'user_api', 'user_mcp', 'worker', 'importer', 'system'));