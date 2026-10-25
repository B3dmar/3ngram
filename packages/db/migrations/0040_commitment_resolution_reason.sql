ALTER TABLE "commitments" ADD COLUMN "last_resolution_reason" text;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_last_resolution_reason_length_check" CHECK (char_length("commitments"."last_resolution_reason") BETWEEN 1 AND 500);
-- Issue #234: the optional `reason` of a commitment's LATEST transition. It is
-- memory content, so it lives on the mutable, erasable commitments row (the
-- runtime role already holds UPDATE here) rather than in the append-only
-- memory_events payload, which account erasure cannot redact. Nullable, no
-- backfill: existing rows have no recorded reason. The length CHECK is
-- generated from MAX_RESOLUTION_REASON_LENGTH in @3ngram/schema.
