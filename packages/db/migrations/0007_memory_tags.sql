ALTER TABLE "memories" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_tags_idx" ON "memories" USING gin ("tags" jsonb_path_ops);