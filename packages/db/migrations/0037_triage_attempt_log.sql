ALTER TABLE "agent_sessions" ADD COLUMN "triage_attempt_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "triage_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill the one attempt that is still RECOVERABLE at migration time: a row
-- sitting `pending` holds its in-flight attempt's token and arm time on the
-- existing columns, and the upcoming `triage/complete` finalizes the log entry
-- by attempt id — without this seed that completed nudge would be permanently
-- missing from the ignore-rate denominator while the read reports an exact
-- empty history (count 0). Attempts that already reached a terminal status
-- left no recoverable identity and are NOT invented; `triage_attempt_count`
-- therefore counts attempts armed since this migration, plus these seeds. A
-- pending row with a NULL `triage_armed_at` (armed before 0036) cannot yield
-- a valid entry and is left empty, matching the "age unknown" precedent.
UPDATE "agent_sessions"
   SET "triage_attempt_log" = jsonb_build_array(jsonb_build_object(
         'attemptId', "triage_attempt_id"::text,
         'armedAt', to_char("triage_armed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )),
       "triage_attempt_count" = 1
 WHERE "triage_status" = 'pending'
   AND "triage_attempt_id" IS NOT NULL
   AND "triage_armed_at" IS NOT NULL;
