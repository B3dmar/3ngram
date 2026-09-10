ALTER TABLE "agent_sessions" ADD COLUMN "triage_attempt_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "triage_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill every attempt that is still IN FLIGHT at migration time: a row
-- sitting `pending` holds its attempt's token (and usually its arm time) on
-- the existing columns, and the upcoming `triage/complete` finalizes the log
-- entry by attempt id — without this seed that completed nudge would be
-- permanently missing from the ignore-rate denominator while the read reports
-- an exact empty history (count 0, truncated false).
--
-- A pending row whose `triage_armed_at` is NULL (armed before 0036) cannot
-- yield a schema-valid entry, so it gets the COUNT without the entry: the
-- triage-attempts read then reports count 1 over an empty list — truncated,
-- i.e. "history known incomplete" — instead of presenting an exact empty
-- history. Attempts that already reached a terminal status left no
-- recoverable identity and are NOT invented; `triage_attempt_count` therefore
-- counts attempts armed since this migration, plus these seeds.
UPDATE "agent_sessions"
   SET "triage_attempt_log" = CASE
         WHEN "triage_armed_at" IS NULL THEN '[]'::jsonb
         ELSE jsonb_build_array(jsonb_build_object(
           'attemptId', "triage_attempt_id"::text,
           'armedAt', to_char("triage_armed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ))
       END,
       "triage_attempt_count" = 1
 WHERE "triage_status" = 'pending'
   AND "triage_attempt_id" IS NOT NULL;
