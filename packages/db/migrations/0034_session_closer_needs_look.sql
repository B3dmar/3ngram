DROP INDEX "agent_sessions_closer_idx";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "needs_look" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- BACKFILL BEFORE THE NARROWED INDEX EXISTS (issue #183). The new predicate drops
-- settled `completed` rows, and the column default would declare every existing
-- one settled — including any that already hold a provenance event outside their
-- watermark, which is exactly the row the closer's `EXISTS` leg exists to catch.
-- Losing those would destroy captured provenance, so the flag is derived once
-- here, by the same probe, rather than assumed. This is the per-tick cost the
-- migration removes, paid a single time. `overflowed` is terminal and out of scope.
--
-- EVERY `completed` ROW, OPEN OR CLOSED. The Stop handshake stamps `completed` on
-- a LEASED-OPEN row, and `closeSession` later stamps `closed_at` and nothing else
-- — no recompute runs on close. So the flag a row carries while open is the flag
-- the narrowed index uses once it closes, and an open row skipped here would be
-- excluded from the closer's scan permanently. Restricting the probe to closed
-- rows would trade a one-off scan for exactly the data loss this backfill exists
-- to prevent. A raised flag on an open row costs nothing: the index predicate
-- still requires `closed_at IS NOT NULL`, so it only becomes scannable on close,
-- and the next watermark stamp recomputes it either way.
UPDATE "agent_sessions" AS s
   SET "needs_look" = true
 WHERE s."triage_status" = 'completed'
   AND EXISTS (
         SELECT 1
           FROM "memory_events" AS e
          WHERE e."user_id" = s."user_id"
            AND e."payload"->>'sessionRunId' = s."id"::text
            AND NOT (s."last_triaged_event_ids" @> to_jsonb(e."id"::text))
       );--> statement-breakpoint
CREATE INDEX "agent_sessions_closer_idx" ON "agent_sessions" USING btree ("user_id","closed_at") WHERE "agent_sessions"."closed_at" IS NOT NULL AND "agent_sessions"."triage_status" <> 'overflowed' AND ("agent_sessions"."triage_status" <> 'completed' OR "agent_sessions"."needs_look");
