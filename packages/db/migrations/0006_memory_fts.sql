-- Phase 1B unified search, FTS leg (slice 1). Forward-only.
-- Generated tsvector over topic + content (english config) so the column
-- cannot drift from the source text, plus a GIN index for ts_rank queries.
-- STORED (not an expression index) keeps ts_rank cheap: the document vector
-- is materialized once on write, never recomputed per query row.
ALTER TABLE "memories" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("topic", '') || ' ' || coalesce("content", ''))
  ) STORED;--> statement-breakpoint
CREATE INDEX "memories_search_tsv_idx" ON "memories" USING gin ("search_tsv");
