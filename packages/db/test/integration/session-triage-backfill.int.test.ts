// SPDX-License-Identifier: Apache-2.0
// Migration 0037's legacy backfill, end to end against real Postgres (issue
// #307). The #166 ignore-rate metric divides by `triage_attempt_count`, so the
// seed this migration wrote for attempts in flight at migration time is part of
// the denominator — and nothing else exercises it: the schema suite cannot run
// SQL, and every later row is written by the begin/complete path instead.
//
// The test replays the migration's own backfill UPDATE (read from the shipped
// .sql file, so a later edit to it is what gets tested) over rows reset to the
// pre-0037 column defaults, then reads them back through the same
// `readAgentSessionRun` the triage-attempts read uses. The `truncated` flag is
// derived in core (`count > items.length`, unit-tested in
// packages/core/test/session-triage-attempts.test.ts); here the row must make
// that derivation read TRUE for a NULL-arm seed and FALSE for an armed one.
import { readFileSync } from 'node:fs'
import { triageAttemptLogEntrySchema } from '@3ngram/schema'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { openSession, readAgentSessionRun } from '../../src/session-lifecycle.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const ARMED_AT = '2026-09-10T11:59:30.000Z'
const LEGACY_ATTEMPT = '01890b6e-0000-7000-8000-0000000037a1'
const ARMED_ATTEMPT = '01890b6e-0000-7000-8000-0000000037a2'

/** The backfill statement exactly as migration 0037 ships it. */
const BACKFILL = (() => {
  const sql = readFileSync(
    new URL('../../migrations/0037_triage_attempt_log.sql', import.meta.url),
    'utf8',
  )
  const statement = sql
    .split('--> statement-breakpoint')
    .find((part) => part.includes('UPDATE "agent_sessions"'))
  if (statement === undefined) throw new Error('0037 backfill UPDATE not found')
  return statement
})()

let uid: string

async function openRun(sessionId: string): Promise<string> {
  const opened = await withTenant(uid, (tx) =>
    openSession(
      tx,
      uid,
      {
        agent: 'claude-code',
        sessionId,
        source: 'startup',
        project: '3ngram',
        selector: { kind: 'all' },
      },
      NOW,
    ),
  )
  return opened.row.id
}

/** Put a run back in its pre-0037 shape: pending, with the given arm instant. */
async function asPreMigrationPending(
  runId: string,
  attemptId: string,
  armedAt: string | null,
): Promise<void> {
  await ownerPool.query(
    `UPDATE agent_sessions
        SET triage_status = 'pending',
            triage_attempt_id = $2,
            triage_armed_at = $3,
            triage_attempt_log = '[]'::jsonb,
            triage_attempt_count = 0
      WHERE id = $1`,
    [runId, attemptId, armedAt],
  )
}

const read = (runId: string) => withTenant(uid, (tx) => readAgentSessionRun(tx, uid, runId))

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('triage-backfill@test.local')
})

afterAll(async () => {
  await closePools()
})

describe('migration 0037 backfill', () => {
  it('seeds a NULL-arm pending row to count 1 over an empty log (history known incomplete)', async () => {
    const runId = await openRun('conv-legacy')
    await asPreMigrationPending(runId, LEGACY_ATTEMPT, null)

    await ownerPool.query(BACKFILL)

    const row = await read(runId)
    expect(row?.triageAttemptCount).toBe(1)
    expect(row?.triageAttemptLog).toEqual([])
    // The core derivation `count > items.length` therefore reads truncated.
    expect((row?.triageAttemptCount ?? 0) > (row?.triageAttemptLog.length ?? 0)).toBe(true)
  })

  it('seeds an armed pending row with one open, schema-valid entry (exact history)', async () => {
    const runId = await openRun('conv-armed')
    await asPreMigrationPending(runId, ARMED_ATTEMPT, ARMED_AT)

    await ownerPool.query(BACKFILL)

    const row = await read(runId)
    expect(row?.triageAttemptCount).toBe(1)
    expect(row?.triageAttemptLog).toEqual([{ attemptId: ARMED_ATTEMPT, armedAt: ARMED_AT }])
    expect(triageAttemptLogEntrySchema.safeParse(row?.triageAttemptLog[0]).success).toBe(true)
    expect((row?.triageAttemptCount ?? 0) > (row?.triageAttemptLog.length ?? 0)).toBe(false)
  })

  it('leaves a run that was not pending untouched (no invented attempts)', async () => {
    const runId = await openRun('conv-idle')

    await ownerPool.query(BACKFILL)

    const row = await read(runId)
    expect(row?.triageAttemptCount).toBe(0)
    expect(row?.triageAttemptLog).toEqual([])
  })
})
