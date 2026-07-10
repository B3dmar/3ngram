DROP INDEX "memories_hash_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "memories_hash_idx" ON "memories" USING btree ("user_id","content_hash") WHERE "memories"."valid_to" IS NULL;