// SPDX-License-Identifier: Apache-2.0
// The Stop-nudge handshake against real Postgres with the runtime role and real
// RLS (docs/concepts/session-continuity.mdx layer 4; issue #166 step 7a).
//
// What the fake-tx suite cannot reach, and this one exists for:
//
//   - the events come from the REAL write path (writeMemory stamping
//     payload.sessionRunId), so `since_begin` and the watermark are computed
//     over the spelling the writer actually persists and the containment test
//     the expression index actually serves;
//   - the WRITE-TIME RE-ARM is a `CASE` evaluated by Postgres inside the attach
//     UPDATE, which no fake tx can execute;
//   - the `jsonb` round-trip of `last_triaged_event_ids`;
//   - tenant isolation on a natural key another tenant also uses.
//
// Concurrency is NOT tested here. A real two-transaction race is
// non-deterministic and hard rule 4 forbids flake retries; the attempt-id fence
// and the row-lock ordering are pinned by the fake-tx suite instead, which
// replays the exact observation sequence each statement sees.
import { SESSION_LEASE_MS, SESSION_SWEEP_GRACE_MS } from '@3ngram/schema'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { writeMemory } from '../../src/memory-write.js'
import { agentSessions } from '../../src/schema/agent-sessions.js'
import {
  claimSessionTriage,
  finishSessionTriage,
  readCloserSession,
  sweepExpiredLeases,
} from '../../src/session-closer.js'
import { closeSession, heartbeatSession, openSession } from '../../src/session-lifecycle.js'
import {
  AgentSessionTriageConflictError,
  beginSessionTriage,
  completeSessionTriage,
} from '../../src/session-triage.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')
const KEY = { agent: 'claude-code', sessionId: 'conv-triage' }
const PROJECT = '3ngram'
const THRESHOLDS = { minTurns: 3, minElapsedMs: 10 * 60_000 }

let uid: string
let other: string
let runId: string
let counter = 0
const nextHash = () => `sess-triage-${Date.now()}-${counter++}`

const attempt = (n: number) => `01890b6e-0000-7000-8000-00000000ff${String(n).padStart(2, '0')}`
/** A token the CLOSER minted — deliberately outside the hook's `attempt(n)` range. */
const CLOSER_ATTEMPT = '01890b6e-0000-7000-8000-0000000c1050'
/** Quiet long enough for the sweep: one lease plus the grace, plus a minute. */
const SWEEPABLE = new Date(NOW.getTime() - SESSION_LEASE_MS - SESSION_SWEEP_GRACE_MS - 60_000)

async function openRun(userId: string, key = KEY): Promise<string> {
  const opened = await withTenant(userId, (tx) =>
    openSession(
      tx,
      userId,
      { ...key, source: 'startup', project: PROJECT, selector: { kind: 'all' } },
      NOW,
    ),
  )
  return opened.row.id
}

/** One real `create` event stamped with this run's provenance. */
async function write(userId: string, sessionRunId: string): Promise<void> {
  await writeMemory({
    userId,
    memoryType: 'note',
    topic: 'triage',
    content: `body-${nextHash()}`,
    scope: 'work',
    project: PROJECT,
    tags: [],
    contentHash: nextHash(),
    actorKind: 'user_api',
    now: NOW,
    sessionRunId,
  })
}

const begin = (
  userId: string,
  over: { attemptId?: string; turnCount?: number; ceiling?: number; key?: typeof KEY } = {},
) =>
  withTenant(userId, (tx) =>
    beginSessionTriage(tx, userId, over.key ?? KEY, {
      attemptId: over.attemptId ?? attempt(1),
      turnCount: over.turnCount ?? THRESHOLDS.minTurns,
      thresholds: THRESHOLDS,
      now: NOW,
      ...(over.ceiling === undefined ? {} : { ceiling: over.ceiling }),
    }),
  )

const complete = (userId: string, attemptId = attempt(1), ceiling?: number) =>
  withTenant(userId, (tx) =>
    completeSessionTriage(tx, userId, KEY, {
      attemptId,
      ...(ceiling === undefined ? {} : { ceiling }),
    }),
  )

async function rawRow(id: string): Promise<Record<string, unknown>> {
  const r = await ownerPool.query(
    `SELECT triage_status, triage_attempt_id, last_triaged_event_ids, last_message_excerpt,
            closer_failure_count, closer_next_attempt_at
       FROM agent_sessions WHERE id = $1`,
    [id],
  )
  return r.rows[0] as Record<string, unknown>
}

const watermark = async (id: string) => (await rawRow(id)).last_triaged_event_ids as string[]

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('sess-triage@test.local')
  other = await seedUser('sess-triage-other@test.local')
  runId = await openRun(uid)
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('begin/complete round trip', () => {
  it('arms, absorbs the continuation write, and stamps completed', async () => {
    const pre = await begin(uid)
    expect(pre).toMatchObject({ sessionRunId: runId, armed: true, triageStatus: 'pending' })
    expect((await rawRow(runId)).triage_attempt_id).toBe(attempt(1))
    // Nothing written yet, so the begin watermark is empty.
    expect(await watermark(runId)).toEqual([])

    await write(uid, runId)

    const done = await complete(uid)
    expect(done).toMatchObject({ triageStatus: 'completed', sinceBeginCount: 1, truncated: false })
    expect(done.eventCount).toBe(1)
    expect(await watermark(runId)).toHaveLength(1)
  })

  it('stamps the CUMULATIVE watermark, not the since-begin slice', async () => {
    // The event the page's own pseudo-code calls out: a write that arms the
    // debounce BEFORE triage/begin must end up in the watermark, or it re-arms
    // the run immediately after the attempt it already paid for.
    await write(uid, runId)
    const armed = await begin(uid)
    const atBegin = await watermark(runId)
    expect(atBegin).toHaveLength(1)

    await write(uid, runId)
    const done = await complete(uid, armed.attemptId)

    expect(done).toMatchObject({ triageStatus: 'completed', sinceBeginCount: 1, eventCount: 2 })
    const after = await watermark(runId)
    expect(after).toHaveLength(2)
    // Cumulative: the pre-attempt id survived the replacement.
    expect(after).toEqual(expect.arrayContaining(atBegin))
  })

  it('expires a zero-write continuation so the closer still runs', async () => {
    await write(uid, runId)
    const armed = await begin(uid)

    const done = await complete(uid, armed.attemptId)

    expect(done).toMatchObject({ triageStatus: 'expired', sinceBeginCount: 0, eventCount: 1 })
    expect((await rawRow(runId)).triage_status).toBe('expired')
  })

  it('never clears last_message_excerpt — only the closer consumes it', async () => {
    await ownerPool.query('UPDATE agent_sessions SET last_message_excerpt = $2 WHERE id = $1', [
      runId,
      'the turn ended here',
    ])
    const armed = await begin(uid)
    await write(uid, runId)
    await complete(uid, armed.attemptId)

    expect((await rawRow(runId)).last_message_excerpt).toBe('the turn ended here')
  })

  it('resets a closer backoff on its own durable write-back too (issue #184 audit F4)', async () => {
    // This handshake's `complete` is the OTHER durable terminal write-back the
    // reset rule names, alongside the closer's own `finishSessionTriage` — see
    // session-triage.ts's doc comment on completeSessionTriage.
    const armed = await begin(uid)
    await ownerPool.query(
      'UPDATE agent_sessions SET closer_failure_count = 2, closer_next_attempt_at = $2 WHERE id = $1',
      [runId, new Date(NOW.getTime() + 40 * 60 * 1000)],
    )
    await write(uid, runId)

    await complete(uid, armed.attemptId)

    const row = await rawRow(runId)
    expect(row.closer_failure_count).toBe(0)
    expect(row.closer_next_attempt_at).toBeNull()
  })
})

describe('truncation', () => {
  it('stamps overflowed at complete when the run passed the ceiling', async () => {
    const armed = await begin(uid, { ceiling: 2 })
    await write(uid, runId)
    await write(uid, runId)
    await write(uid, runId)

    const done = await complete(uid, armed.attemptId, 2)

    expect(done).toMatchObject({ triageStatus: 'overflowed', truncated: true })
    expect((await rawRow(runId)).triage_status).toBe('overflowed')
  })

  it('stamps overflowed at BEGIN when the run is already past the ceiling', async () => {
    // Converges instead of re-listing the ceiling on every later Stop, and does
    // NOT write a partial watermark: marking never-triaged ids as triaged is a
    // lie the closer would then trust.
    await write(uid, runId)
    await write(uid, runId)
    await write(uid, runId)

    const declined = await begin(uid, { ceiling: 2 })

    expect(declined).toMatchObject({
      armed: false,
      triageStatus: 'overflowed',
      reason: 'overflowed',
    })
    expect(await watermark(runId)).toEqual([])
    // Terminal: a later Stop does not re-enter, whatever the signal says.
    expect(await begin(uid, { attemptId: attempt(2) })).toMatchObject({
      armed: false,
      reason: 'terminal',
    })
  })
})

describe('the attempt-id fence', () => {
  it('rejects a stale complete carrying a superseded attempt id', async () => {
    // Boundary case (a) of the closer-coexistence contract, minus the timing:
    // whatever replaced the token — a closer CAS after the sweep closed the row,
    // or a second begin — the older attempt cannot clobber the newer verdict.
    await begin(uid)
    await ownerPool.query('UPDATE agent_sessions SET triage_attempt_id = $2 WHERE id = $1', [
      runId,
      attempt(9),
    ])

    await expect(complete(uid, attempt(1))).rejects.toBeInstanceOf(AgentSessionTriageConflictError)
    expect((await rawRow(runId)).triage_status).toBe('pending')
  })

  it('rejects a repeat complete of the SAME attempt', async () => {
    const armed = await begin(uid)
    await write(uid, runId)
    await complete(uid, armed.attemptId)

    // Without the `pending` leg the second call would recompute since_begin as
    // empty and demote a completed run to expired.
    await expect(complete(uid, armed.attemptId)).rejects.toBeInstanceOf(
      AgentSessionTriageConflictError,
    )
    expect((await rawRow(runId)).triage_status).toBe('completed')
  })

  it('composes with a closer claim taken after the lease expired mid-handshake', async () => {
    // begin arms attempt 1 on a live row; the session dies and the sweep closes
    // it; `pending` is closer-eligible, so the closer CASes its own token in and
    // finishes. The late complete then fails BOTH fence legs.
    const armed = await begin(uid)
    expect(armed.armed).toBe(true)
    await ownerPool.query(
      `UPDATE agent_sessions
          SET closed_at = $2, triage_attempt_id = $3, triage_status = 'completed'
        WHERE id = $1`,
      [runId, NOW, attempt(7)],
    )

    await expect(complete(uid, armed.attemptId)).rejects.toBeInstanceOf(
      AgentSessionTriageConflictError,
    )
    const row = await rawRow(runId)
    expect(row.triage_attempt_id).toBe(attempt(7))
    expect(row.triage_status).toBe('completed')
  })

  // THE FULL INTERLEAVING, through the REAL statements on both sides — the
  // sweep, the closer's CAS and its fenced write-back, a real resurrection, then
  // the hook coming back. Hand-written UPDATEs would only prove the assertions
  // agree with themselves.
  //
  // The bug this pins: if the closer's claim left `triage_status = 'pending'`,
  // resurrection (which preserves the status AND the token) would republish the
  // CLOSER's attempt id through `begin`'s `pending` reply, and `complete` would
  // accept it — letting the hook stamp a terminal status for a continuation that
  // never happened, from a begin watermark belonging to a session that had died.
  // Because ordinary post-resurrection MCP traffic makes `since_begin` non-empty,
  // that outcome is `completed`, which is NOT closer-eligible: a run that should
  // have stayed eligible is silently retired.
  it('claim -> resurrect -> fenced finish -> the hook can never complete the closer attempt', async () => {
    const armed = await begin(uid)
    expect(armed).toMatchObject({ armed: true, attemptId: attempt(1) })

    // 1. The session dies and the sweep closes it. The epoch does NOT move.
    await ownerPool.query('UPDATE agent_sessions SET last_seen_at = $2 WHERE id = $1', [
      runId,
      SWEEPABLE,
    ])
    const swept = await withTenant(uid, (tx) => sweepExpiredLeases(tx, uid, NOW, 10))
    expect(swept).toEqual([{ sessionRunId: runId, activationEpoch: 1 }])

    // 2. The closer observes the abandoned handshake and claims it.
    const observed = await withTenant(uid, (tx) => readCloserSession(tx, uid, runId))
    expect(observed).toMatchObject({ triageStatus: 'pending', triageAttemptId: attempt(1) })
    const claimed = await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: attempt(1),
        attemptId: CLOSER_ATTEMPT,
      }),
    )
    expect(claimed).toBe(true)
    // The claim RETIRES the handshake: a closed row still `pending` is an attempt
    // whose session ended before complete, and the closer is taking it over.
    expect(await rawRow(runId)).toMatchObject({
      triage_status: 'expired',
      triage_attempt_id: CLOSER_ATTEMPT,
    })

    // 3. The user comes back. Resurrection bumps the epoch and preserves the
    //    triage columns (`expired` is not flipped by the write-time re-arm).
    const beat = await withTenant(uid, (tx) => heartbeatSession(tx, uid, KEY, NOW))
    expect(beat.resurrected).toBe(true)
    expect(beat.row.activationEpoch).toBe(2)
    expect(await rawRow(runId)).toMatchObject({ triage_status: 'expired' })

    // 4. The closer's write-back is fenced out by the epoch and lands nothing.
    const finished = await withTenant(uid, (tx) =>
      finishSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        attemptId: CLOSER_ATTEMPT,
        triageStatus: 'completed',
        visibleEventIds: [],
        clearExcerpt: true,
      }),
    )
    expect(finished).toBe(false)

    // 5. The hook's next Stop. No foreign token is published, and with no new
    //    provenance the expired entry rule declines rather than re-injecting.
    const declined = await begin(uid, { attemptId: attempt(2), turnCount: 9999 })
    expect(declined).toMatchObject({ armed: false, triageStatus: 'expired', reason: 'no-signal' })
    expect(declined.attemptId).toBeUndefined()

    // 6. Neither the hook's own dead token nor the closer's can complete.
    for (const token of [attempt(1), CLOSER_ATTEMPT]) {
      await expect(complete(uid, token)).rejects.toBeInstanceOf(AgentSessionTriageConflictError)
    }
    expect(await rawRow(runId)).toMatchObject({ triage_status: 'expired' })

    // 7. Real new provenance re-admits it — under the HOOK's own fresh attempt
    //    and a fresh begin watermark, not the corpse of the old one.
    await write(uid, runId)
    const rearmed = await begin(uid, { attemptId: attempt(3) })
    expect(rearmed).toMatchObject({ armed: true, attemptId: attempt(3) })
    expect(await rawRow(runId)).toMatchObject({ triage_attempt_id: attempt(3) })
    await write(uid, runId)
    await expect(complete(uid, attempt(3))).resolves.toMatchObject({
      triageStatus: 'completed',
      sinceBeginCount: 1,
    })
  })
})

describe('the entry rule against a real row', () => {
  it('never arms a closed row, and does not resurrect it', async () => {
    // (b): deciding is not touching. The lease belongs to /heartbeat.
    await withTenant(uid, (tx) => closeSession(tx, uid, KEY, NOW))

    const declined = await begin(uid)

    expect(declined).toMatchObject({ armed: false, reason: 'not-live' })
    const [row] = await withTenant(uid, (tx) =>
      tx
        .select({ closedAt: agentSessions.closedAt, epoch: agentSessions.activationEpoch })
        .from(agentSessions),
    )
    expect(row?.closedAt).not.toBeNull()
    expect(row?.epoch).toBe(1)
  })

  it('declines a fresh idle session with no substance', async () => {
    expect(await begin(uid, { turnCount: 0 })).toMatchObject({
      armed: false,
      triageStatus: 'idle',
      reason: 'debounce',
    })
  })

  it('declines a completed run with no untriaged event', async () => {
    // The continuation's write was absorbed into the watermark by `complete`,
    // so the run holds no untriaged signal and elapsed time cannot re-enter it.
    // A `completed` run only re-arms on NEW provenance.
    const armed = await begin(uid)
    await write(uid, runId)
    await complete(uid, armed.attemptId)

    expect(await begin(uid, { attemptId: attempt(2), turnCount: 9999 })).toMatchObject({
      armed: false,
      triageStatus: 'completed',
      reason: 'no-signal',
    })
  })

  it('hands back the in-flight attempt on a pending row rather than double-arming', async () => {
    await begin(uid)

    const second = await begin(uid, { attemptId: attempt(2) })

    expect(second).toMatchObject({ armed: false, reason: 'pending', attemptId: attempt(1) })
    expect((await rawRow(runId)).triage_attempt_id).toBe(attempt(1))
  })

  it('re-enters an EXPIRED run only on new provenance', async () => {
    const armed = await begin(uid)
    await complete(uid, armed.attemptId)
    expect((await rawRow(runId)).triage_status).toBe('expired')

    // Elapsed time and turn count alone must not re-inject on a zero-write
    // continuation — that is the cross-turn nag loop the page rules out.
    expect(await begin(uid, { attemptId: attempt(2), turnCount: 9999 })).toMatchObject({
      armed: false,
      reason: 'no-signal',
    })

    await write(uid, runId)
    expect(await begin(uid, { attemptId: attempt(3) })).toMatchObject({
      armed: true,
      attemptId: attempt(3),
    })
  })

  it('404s a natural key another tenant owns', async () => {
    await openRun(other)
    await expect(begin(other, { key: { agent: KEY.agent, sessionId: 'nope' } })).rejects.toThrow()
    // The other tenant's own row for the SAME key is a different row entirely.
    const theirs = await begin(other, { turnCount: 0 })
    expect(theirs.sessionRunId).not.toBe(runId)
  })
})

describe('re-arm on write', () => {
  it('flips a completed run back to idle inside the attach transaction', async () => {
    const armed = await begin(uid)
    await write(uid, runId)
    await complete(uid, armed.attemptId)
    expect((await rawRow(runId)).triage_status).toBe('completed')

    await write(uid, runId)

    // No rescan of the watermark: the new event id is by construction outside a
    // set stamped before it existed, so the attach flips unconditionally.
    expect((await rawRow(runId)).triage_status).toBe('idle')
  })

  it('leaves pending, expired and overflowed alone', async () => {
    for (const status of ['pending', 'expired', 'overflowed'] as const) {
      await ownerPool.query('UPDATE agent_sessions SET triage_status = $2 WHERE id = $1', [
        runId,
        status,
      ])
      await write(uid, runId)
      expect((await rawRow(runId)).triage_status, status).toBe(status)
    }
  })

  it('lets the re-armed run be nudged again, and grows the watermark', async () => {
    const first = await begin(uid)
    await write(uid, runId)
    await complete(uid, first.attemptId)
    const afterFirst = await watermark(runId)

    await write(uid, runId)
    const second = await begin(uid, { attemptId: attempt(2) })
    expect(second.armed).toBe(true)
    await write(uid, runId)
    const done = await complete(uid, second.attemptId)

    expect(done).toMatchObject({ triageStatus: 'completed', sinceBeginCount: 1, eventCount: 3 })
    expect(await watermark(runId)).toEqual(expect.arrayContaining(afterFirst))
  })
})
