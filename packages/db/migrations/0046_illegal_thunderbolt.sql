ALTER TABLE "consolidation_proposals" ADD CONSTRAINT "consolidation_proposals_tenant_id_uq" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "fact_proposals" ADD CONSTRAINT "fact_proposals_tenant_id_uq" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "resolution_proposals" ADD CONSTRAINT "resolution_proposals_tenant_id_uq" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "retention_proposals" ADD CONSTRAINT "retention_proposals_tenant_id_uq" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "source_fact_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD COLUMN "source_consolidation_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD COLUMN "source_retention_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_proposal_fk" FOREIGN KEY ("user_id","source_fact_proposal_id") REFERENCES "public"."fact_proposals"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_consolidation_proposal_fk" FOREIGN KEY ("user_id","source_consolidation_proposal_id") REFERENCES "public"."consolidation_proposals"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_retention_proposal_fk" FOREIGN KEY ("user_id","source_retention_proposal_id") REFERENCES "public"."retention_proposals"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facts_proposal_idx" ON "facts" USING btree ("user_id","source_fact_proposal_id");--> statement-breakpoint
CREATE INDEX "memory_edges_consolidation_proposal_idx" ON "memory_edges" USING btree ("user_id","source_consolidation_proposal_id");--> statement-breakpoint
CREATE INDEX "memory_edges_retention_proposal_idx" ON "memory_edges" USING btree ("user_id","source_retention_proposal_id");--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_one_producer_check" CHECK ("memory_edges"."source_consolidation_proposal_id" IS NULL OR "memory_edges"."source_retention_proposal_id" IS NULL);