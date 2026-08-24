DROP INDEX "agent_sessions_closer_idx";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "needs_look" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- BACKFILL BEFORE THE NARROWED INDEX EXISTS (issue #183). The new predicate drops
-- settled `completed` rows, and the column default would declare every existing
-- one settled — including any that already hold a provenance event outside their
-- watermark, which is exactly the row the closer's `EXISTS` leg exists to catch.
-- Losing those would destroy captured provenance, so the flag is derived once
-- here, by the same probe, rather than assumed. This is the per-tick cost the
-- migration removes, paid a single time. `overflowed` is terminal and out of
-- scope; open rows are not candidates.
UPDATE "agent_sessions" AS s
   SET "needs_look" = true
 WHERE s."closed_at" IS NOT NULL
   AND s."triage_status" = 'completed'
   AND EXISTS (
         SELECT 1
           FROM "memory_events" AS e
          WHERE e."user_id" = s."user_id"
            AND e."payload"->>'sessionRunId' = s."id"::text
            AND NOT (s."last_triaged_event_ids" @> to_jsonb(e."id"::text))
       );--> statement-breakpoint
CREATE INDEX "agent_sessions_closer_idx" ON "agent_sessions" USING btree ("user_id","closed_at") WHERE "agent_sessions"."closed_at" IS NOT NULL AND "agent_sessions"."triage_status" <> 'overflowed' AND ("agent_sessions"."triage_status" <> 'completed' OR "agent_sessions"."needs_look");
