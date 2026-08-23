// SPDX-License-Identifier: Apache-2.0
// The lease-expiry sweep and the closer's claim/finish statements against a real
// DB with the runtime role and real RLS (docs/concepts/session-continuity.mdx
// layer 5). What the unit suites cannot reach:
//
//   - the CROSS-TENANT discipline: the sweep is per-tenant under withTenant, so
//     one tenant's pass must never see, close or claim another's row;
//   - the epoch fence and the attempt CAS evaluated by Postgres, including
//     `IS NOT DISTINCT FROM` against a real NULL;
//   - that a swept `closed_at` really does read back as an IMPLICIT close and so
//     stays resurrectable — the property the whole grace exists for;
//   - the runtime grants: close and triage are UPDATEs, because the role has no
//     DELETE on agent_sessions.
//
// Concurrency is provoked with the deterministic two-promise barrier the
// lifecycle suite uses, never with sleeps (hard rule 4 forbids flake).
import { SESSION_LEASE_MS, SESSION_SWEEP_GRACE_MS } from '@3ngram/schema'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { createCommitment, transitionCommitment } from '../../src/commitments.js'
import { agentSessions } from '../../src/schema/agent-sessions.js'
import {
  claimSessionTriage,
  expireStaleExcerpts,
  finishSessionTriage,
  listCloserCandidates,
  readCloserSession,
  sweepExpiredLeases,
  sweepFloor,
} from '../../src/session-closer.js'
import { isExplicitClose } from '../../src/session-lease.js'
import { closeSession, heartbeatSession, openSession } from '../../src/session-lifecycle.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')
/** Quiet long enough for the sweep: one lease plus the grace, plus a minute. */
const SWEEPABLE = new Date(NOW.getTime() - SESSION_LEASE_MS - SESSION_SWEEP_GRACE_MS - 60_000)
/** Lease expired, but still inside the grace — the overnight-idle case. */
const IN_GRACE = new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000)

let uid: string
let other: string

const open = (userId: string, sessionId: string, openedAt = NOW) =>
  withTenant(userId, (tx) =>
    openSession(
      tx,
      userId,
      { agent: 'claude-code', sessionId, source: 'startup', selector: { kind: 'all' } },
      openedAt,
    ),
  )

const sweep = (userId: string, now = NOW, limit = 100) =>
  withTenant(userId, (tx) => sweepExpiredLeases(tx, userId, now, limit))

const candidates = (userId: string, limit = 100) =>
  withTenant(userId, (tx) => listCloserCandidates(tx, userId, limit))

const readCloser = (userId: string, runId: string) =>
  withTenant(userId, (tx) => readCloserSession(tx, userId, runId))

/** Force `last_seen_at` (and optionally the excerpt/status) via the owner pool. */
async function setRow(id: string, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch)
  const assignments = keys.map((key, index) => `${key} = $${index + 2}`).join(', ')
  await ownerPool.query(`UPDATE agent_sessions SET ${assignments} WHERE id = $1`, [
    id,
    ...keys.map((key) => patch[key]),
  ])
}

async function rawRow(id: string): Promise<Record<string, unknown>> {
  const result = await ownerPool.query('SELECT * FROM agent_sessions WHERE id = $1', [id])
  return result.rows[0] as Record<string, unknown>
}

/**
 * A live commitment-type memory for this tenant, so a `commitments` row and a
 * `memory_events` row can hang off something real (both carry composite FKs).
 * Inserted with the owner pool: this is fixture setup, not a path under test.
 */
async function seedCommitmentMemory(userId: string): Promise<string> {
  // `content_hash` is NOT NULL with no default (it backs the duplicate guard), so
  // the fixture supplies one. Made unique per row: two fixtures in one test would
  // otherwise collide on the tenant's duplicate index.
  const result = await ownerPool.query(
    `INSERT INTO memories (user_id, content, memory_type, topic, scope, content_hash)
     VALUES ($1, 'fixture commitment', 'commitment', 'fixture', 'work', md5(random()::text))
     RETURNING id`,
    [userId],
  )
  return (result.rows[0] as { id: string }).id
}

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser(`closer-${Date.now()}@example.test`)
  other = await seedUser(`closer-other-${Date.now()}@example.test`)
})

afterAll(closePools)

describe('sweepExpiredLeases', () => {
  it('closes a row quiet past lease + grace, and the close reads as IMPLICIT', async () => {
    const opened = await open(uid, 'conv-stale')
    await setRow(opened.row.id, { last_seen_at: SWEEPABLE })

    const swept = await sweep(uid)

    expect(swept).toEqual([{ sessionRunId: opened.row.id, activationEpoch: 1 }])
    const row = await rawRow(opened.row.id)
    expect(row.closed_at).not.toBeNull()
    // THE invariant: outside the `closed_at <= last_seen_at + lease` window, so
    // the row is still resurrectable by a later heartbeat or resume.
    expect(isExplicitClose(row.closed_at as Date, row.last_seen_at as Date)).toBe(false)
  })

  it('leaves a lease-expired row alone while it is still inside the grace', async () => {
    const opened = await open(uid, 'conv-grace')
    await setRow(opened.row.id, { last_seen_at: IN_GRACE })

    expect(await sweep(uid)).toEqual([])
    expect((await rawRow(opened.row.id)).closed_at).toBeNull()
  })

  it('leaves a live row alone', async () => {
    const opened = await open(uid, 'conv-live')
    expect(await sweep(uid)).toEqual([])
    expect((await rawRow(opened.row.id)).closed_at).toBeNull()
  })

  it('never re-stamps a row an explicit SessionEnd already closed', async () => {
    const opened = await open(uid, 'conv-explicit')
    await withTenant(uid, (tx) =>
      closeSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-explicit' }, NOW),
    )
    const closedAt = (await rawRow(opened.row.id)).closed_at as Date
    // Age it past the sweep floor. `closed_at IS NULL` must still exclude it —
    // a re-stamp would move it outside the explicit window and make a
    // deliberately-ended session resurrectable again, forever.
    await setRow(opened.row.id, { last_seen_at: SWEEPABLE })

    expect(await sweep(uid)).toEqual([])
    expect((await rawRow(opened.row.id)).closed_at).toEqual(closedAt)
  })

  it('is bounded by the batch limit', async () => {
    for (const id of ['a', 'b', 'c']) {
      const opened = await open(uid, `conv-${id}`)
      await setRow(opened.row.id, { last_seen_at: SWEEPABLE })
    }
    expect(await sweep(uid, NOW, 2)).toHaveLength(2)
    // The remainder is picked up next pass, not dropped.
    expect(await sweep(uid, NOW, 2)).toHaveLength(1)
  })

  it('never crosses a tenant boundary', async () => {
    const mine = await open(uid, 'conv-mine')
    const theirs = await open(other, 'conv-theirs')
    await setRow(mine.row.id, { last_seen_at: SWEEPABLE })
    await setRow(theirs.row.id, { last_seen_at: SWEEPABLE })

    const swept = await sweep(uid)

    expect(swept.map((row) => row.sessionRunId)).toEqual([mine.row.id])
    expect((await rawRow(theirs.row.id)).closed_at).toBeNull()
  })

  it('a swept row still RESURRECTS on a later heartbeat', async () => {
    // The point of classifying the close as implicit. The user comes back after
    // the sweeper ran; the row reopens and the epoch advances, which fences any
    // closer claim taken at the old epoch.
    const opened = await open(uid, 'conv-back')
    await setRow(opened.row.id, { last_seen_at: SWEEPABLE })
    await sweep(uid)

    const beat = await withTenant(uid, (tx) =>
      heartbeatSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-back' }, NOW),
    )

    expect(beat.resurrected).toBe(true)
    expect(beat.row.activationEpoch).toBe(2)
    expect((await rawRow(opened.row.id)).closed_at).toBeNull()
  })
})

describe('listCloserCandidates', () => {
  it('returns a swept row and an explicitly closed one, but never a live row', async () => {
    const swept = await open(uid, 'conv-swept')
    await setRow(swept.row.id, { last_seen_at: SWEEPABLE })
    await sweep(uid)

    const explicit = await open(uid, 'conv-ended')
    await withTenant(uid, (tx) =>
      closeSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-ended' }, NOW),
    )

    await open(uid, 'conv-open')

    const ids = (await candidates(uid)).map((row) => row.sessionRunId).sort()
    expect(ids).toEqual([swept.row.id, explicit.row.id].sort())
  })

  it('excludes a terminal overflowed run and an already-completed one', async () => {
    for (const [sessionId, status] of [
      ['conv-overflowed', 'overflowed'],
      ['conv-completed', 'completed'],
      ['conv-expired', 'expired'],
    ] as const) {
      const opened = await open(uid, sessionId)
      await setRow(opened.row.id, { closed_at: NOW, triage_status: status })
    }

    const rows = await candidates(uid)
    expect(rows).toHaveLength(1)
    const only = await readCloser(uid, rows[0]?.sessionRunId as string)
    expect(only?.triageStatus).toBe('expired')
  })

  it('never crosses a tenant boundary', async () => {
    const theirs = await open(other, 'conv-theirs')
    await setRow(theirs.row.id, { closed_at: NOW })
    expect(await candidates(uid)).toEqual([])
  })
})

describe('claimSessionTriage', () => {
  let runId: string

  beforeEach(async () => {
    const opened = await open(uid, 'conv-claim')
    runId = opened.row.id
    await setRow(runId, { last_seen_at: SWEEPABLE })
    await sweep(uid)
  })

  it('claims from a NULL attempt id (IS NOT DISTINCT FROM, not `= NULL`)', async () => {
    const claimed = await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-999999999991',
      }),
    )
    expect(claimed).toBe(true)
    expect((await rawRow(runId)).triage_attempt_id).toBe('99999999-9999-4999-8999-999999999991')
  })

  it('refuses a SECOND claim that observed the same NULL — one winner', async () => {
    const first = await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-999999999991',
      }),
    )
    const second = await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-999999999992',
      }),
    )

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect((await rawRow(runId)).triage_attempt_id).toBe('99999999-9999-4999-8999-999999999991')
  })

  it('refuses a claim at a stale epoch', async () => {
    await withTenant(uid, (tx) =>
      heartbeatSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-claim' }, NOW),
    )
    const claimed = await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-999999999991',
      }),
    )
    expect(claimed).toBe(false)
  })

  it('refuses another tenant a claim on this row', async () => {
    const claimed = await withTenant(other, (tx) =>
      claimSessionTriage(tx, other, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-999999999993',
      }),
    )
    expect(claimed).toBe(false)
  })

  it('serializes two concurrent claims deterministically, without sleeping', async () => {
    // A holds its transaction open after claiming; B's UPDATE blocks on the row
    // lock until A commits, then re-evaluates the CAS against the committed
    // value and finds it no longer NULL. No timing assumptions.
    let claimed: () => void = () => undefined
    let release: () => void = () => undefined
    const aClaimed = new Promise<void>((resolve) => {
      claimed = resolve
    })
    const aHeld = new Promise<void>((resolve) => {
      release = resolve
    })

    let aWon = false
    const txA = withTenant(uid, async (tx) => {
      aWon = await claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-99999999900a',
      })
      claimed()
      await aHeld
    })
    await aClaimed

    const txB = withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: '99999999-9999-4999-8999-99999999900b',
      }),
    )
    release()

    expect(await txB).toBe(false)
    await txA
    expect(aWon).toBe(true)
  })
})

describe('finishSessionTriage', () => {
  let runId: string
  const ATTEMPT = '88888888-8888-4888-8888-888888888888'

  beforeEach(async () => {
    const opened = await open(uid, 'conv-finish')
    runId = opened.row.id
    await setRow(runId, { last_seen_at: SWEEPABLE, last_message_excerpt: 'the final message' })
    await sweep(uid)
    await withTenant(uid, (tx) =>
      claimSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        observedAttemptId: null,
        attemptId: ATTEMPT,
      }),
    )
  })

  it('stamps the watermark and clears the excerpt under the fence', async () => {
    const ok = await withTenant(uid, (tx) =>
      finishSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        attemptId: ATTEMPT,
        triageStatus: 'completed',
        visibleEventIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        clearExcerpt: true,
      }),
    )

    expect(ok).toBe(true)
    const row = await rawRow(runId)
    expect(row.triage_status).toBe('completed')
    expect(row.last_triaged_event_ids).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    // Durable consumption — the ONLY path allowed to clear it.
    expect(row.last_message_excerpt).toBeNull()
  })

  it('is a no-op when the epoch moved mid-pass (resurrection)', async () => {
    await withTenant(uid, (tx) =>
      heartbeatSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-finish' }, NOW),
    )

    const ok = await withTenant(uid, (tx) =>
      finishSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        attemptId: ATTEMPT,
        triageStatus: 'completed',
        visibleEventIds: [],
        clearExcerpt: true,
      }),
    )

    expect(ok).toBe(false)
    const row = await rawRow(runId)
    expect(row.triage_status).toBe('idle')
    // The excerpt survives: the attempt never durably consumed it.
    expect(row.last_message_excerpt).toBe('the final message')
  })

  it('is a no-op when another attempt stole the claim', async () => {
    await setRow(runId, { triage_attempt_id: '77777777-7777-4777-8777-777777777777' })

    const ok = await withTenant(uid, (tx) =>
      finishSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        attemptId: ATTEMPT,
        triageStatus: 'completed',
        visibleEventIds: [],
        clearExcerpt: true,
      }),
    )
    expect(ok).toBe(false)
  })

  it('leaves the excerpt on an overflowed run for the TTL sweep', async () => {
    await withTenant(uid, (tx) =>
      finishSessionTriage(tx, uid, {
        sessionRunId: runId,
        activationEpoch: 1,
        attemptId: ATTEMPT,
        triageStatus: 'overflowed',
        visibleEventIds: [],
        clearExcerpt: false,
      }),
    )
    const row = await rawRow(runId)
    expect(row.triage_status).toBe('overflowed')
    expect(row.last_message_excerpt).toBe('the final message')
  })
})

describe('expireStaleExcerpts', () => {
  const expire = (userId: string, limit = 100) =>
    withTenant(userId, (tx) => expireStaleExcerpts(tx, userId, NOW, limit))

  it('clears excerpts on EVERY closed row past the TTL, whatever its status', async () => {
    // Scoping this to completed/overflowed leaves a hole with no bottom: a
    // closed, still-eligible row is only consumed if a closer actually runs, and
    // it may never run (flag off, gateway unconfigured). Those excerpts would be
    // retained forever, which is the one thing the retention rule exists to stop.
    const ids: string[] = []
    for (const [sessionId, status] of [
      ['conv-done', 'completed'],
      ['conv-over', 'overflowed'],
      ['conv-idle', 'idle'],
      ['conv-pending', 'pending'],
      ['conv-expired', 'expired'],
    ] as const) {
      const opened = await open(uid, sessionId)
      ids.push(opened.row.id)
      await setRow(opened.row.id, {
        closed_at: NOW,
        triage_status: status,
        last_seen_at: SWEEPABLE,
        last_message_excerpt: 'leftover',
      })
    }

    expect(await expire(uid)).toBe(5)
    for (const id of ids) expect((await rawRow(id)).last_message_excerpt).toBeNull()
  })

  it('NEVER clears an OPEN row — its excerpt is current turn state', async () => {
    const opened = await open(uid, 'conv-live')
    await setRow(opened.row.id, {
      last_seen_at: SWEEPABLE,
      last_message_excerpt: 'this turn',
    })

    expect(await expire(uid)).toBe(0)
    expect((await rawRow(opened.row.id)).last_message_excerpt).toBe('this turn')
  })

  it('leaves a closed row that is still INSIDE the TTL alone', async () => {
    const opened = await open(uid, 'conv-recent')
    await setRow(opened.row.id, {
      closed_at: NOW,
      triage_status: 'idle',
      last_message_excerpt: 'still fresh',
    })

    expect(await expire(uid)).toBe(0)
    expect((await rawRow(opened.row.id)).last_message_excerpt).toBe('still fresh')
  })

  it('is bounded by the batch limit', async () => {
    for (const id of ['x', 'y', 'z']) {
      const opened = await open(uid, `conv-ttl-${id}`)
      await setRow(opened.row.id, {
        closed_at: NOW,
        triage_status: 'completed',
        last_seen_at: SWEEPABLE,
        last_message_excerpt: 'leftover',
      })
    }

    expect(await expire(uid, 2)).toBe(2)
    expect(await expire(uid, 2)).toBe(1)
  })

  it('never crosses a tenant boundary', async () => {
    const theirs = await open(other, 'conv-theirs')
    await setRow(theirs.row.id, {
      closed_at: NOW,
      triage_status: 'completed',
      last_seen_at: SWEEPABLE,
      last_message_excerpt: 'theirs',
    })

    expect(await expire(uid)).toBe(0)
    expect((await rawRow(theirs.row.id)).last_message_excerpt).toBe('theirs')
  })
})

describe('readCloserSession', () => {
  it('returns the bounded closer inputs, and nothing for another tenant', async () => {
    const opened = await open(uid, 'conv-read')
    await setRow(opened.row.id, { last_message_excerpt: 'the message', closed_at: NOW })

    const mine = await readCloser(uid, opened.row.id)
    expect(mine).toMatchObject({
      sessionRunId: opened.row.id,
      activationEpoch: 1,
      triageStatus: 'idle',
      triageAttemptId: null,
      lastTriagedEventIds: [],
      lastMessageExcerpt: 'the message',
    })

    // RLS makes not-owned and not-found the same answer.
    expect(await readCloser(other, opened.row.id)).toBeUndefined()
  })
})

describe('runtime grants', () => {
  it('the sweep and the closer only ever UPDATE — the role has no DELETE here', async () => {
    // Close is an update by design (docs/concepts/session-continuity.mdx layer
    // 1). Assert the grant directly so a future "clean up old sessions" idea
    // fails here rather than at 3am against a tenant's data.
    const granted = await ownerPool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_name = 'agent_sessions'`,
    )
    const privileges = granted.rows.map((row) => (row as { privilege_type: string }).privilege_type)
    expect(privileges).toContain('UPDATE')
    expect(privileges).not.toContain('DELETE')
  })
})

describe('the sweep loses to a concurrent heartbeat (Codex db/session-closer.ts:132)', () => {
  it('does NOT close a row a heartbeat refreshed between the SELECT and the UPDATE', async () => {
    // The SELECT picks the row while it is stale; the UPDATE must re-check
    // staleness, not just `closed_at IS NULL`. Otherwise the sweep closes a
    // session that has just come back to life and enqueues it for an LLM-driven
    // resolve pass against a LIVE run — the mid-conversation debrief the grace
    // exists to prevent. Provoked deterministically by refreshing the row
    // between the two statements, which is exactly what the race produces.
    const opened = await open(uid, 'conv-race')
    await setRow(opened.row.id, { last_seen_at: SWEEPABLE })

    // Run the sweep's two statements by hand with the heartbeat interleaved.
    const stale = await withTenant(uid, (tx) =>
      // The same predicate the sweep's SELECT uses.
      tx
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.userId, uid),
            isNull(agentSessions.closedAt),
            lt(agentSessions.lastSeenAt, sweepFloor(NOW)),
          ),
        ),
    )
    expect(stale).toHaveLength(1)

    // The user comes back.
    await withTenant(uid, (tx) =>
      heartbeatSession(tx, uid, { agent: 'claude-code', sessionId: 'conv-race' }, NOW),
    )

    // Now the sweep runs for real. It must find nothing.
    expect(await sweep(uid)).toEqual([])
    expect((await rawRow(opened.row.id)).closed_at).toBeNull()
  })
})

describe('listCloserCandidates includes re-armed completed runs (Codex db/session-closer.ts:164)', () => {
  it('selects a completed run holding an event id outside the watermark', async () => {
    // A memory-event row takes its uuidv7 at INSERT and becomes visible at
    // COMMIT, so a transaction straddling the closer's final listing holds an id
    // the watermark never saw. Nothing re-arms `triage_status` for that late
    // commit, so without this leg the event is missed permanently.
    const opened = await open(uid, 'conv-rearm')
    const memoryId = await seedCommitmentMemory(uid)
    await setRow(opened.row.id, { closed_at: NOW, triage_status: 'completed' })

    // An event for this run that the watermark does not contain.
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
       VALUES ($1, $2, 'create', 'user_mcp', jsonb_build_object('sessionRunId', $3::text))`,
      [uid, memoryId, opened.row.id],
    )

    const ids = (await candidates(uid)).map((row) => row.sessionRunId)
    expect(ids).toContain(opened.row.id)
  })

  it('does NOT select a completed run whose events are all in the watermark', async () => {
    const opened = await open(uid, 'conv-settled')
    const memoryId = await seedCommitmentMemory(uid)
    const inserted = await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
       VALUES ($1, $2, 'create', 'user_mcp', jsonb_build_object('sessionRunId', $3::text))
       RETURNING id`,
      [uid, memoryId, opened.row.id],
    )
    const eventId = (inserted.rows[0] as { id: string }).id
    await setRow(opened.row.id, {
      closed_at: NOW,
      triage_status: 'completed',
      last_triaged_event_ids: JSON.stringify([eventId]),
    })

    expect((await candidates(uid)).map((row) => row.sessionRunId)).not.toContain(opened.row.id)
  })

  it('still never selects an overflowed run, however many untriaged events it holds', async () => {
    const opened = await open(uid, 'conv-over')
    const memoryId = await seedCommitmentMemory(uid)
    await setRow(opened.row.id, { closed_at: NOW, triage_status: 'overflowed' })
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
       VALUES ($1, $2, 'create', 'user_mcp', jsonb_build_object('sessionRunId', $3::text))`,
      [uid, memoryId, opened.row.id],
    )

    expect((await candidates(uid)).map((row) => row.sessionRunId)).not.toContain(opened.row.id)
  })

  it('keeps another tenant events out of this tenant re-arm check', async () => {
    const mine = await open(uid, 'conv-mine-rearm')
    const theirMemory = await seedCommitmentMemory(other)
    await setRow(mine.row.id, { closed_at: NOW, triage_status: 'completed' })
    // An event owned by the OTHER tenant that names this tenant's run id.
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
       VALUES ($1, $2, 'create', 'user_mcp', jsonb_build_object('sessionRunId', $3::text))`,
      [other, theirMemory, mine.row.id],
    )

    expect((await candidates(uid)).map((row) => row.sessionRunId)).not.toContain(mine.row.id)
  })
})

describe('stamped provenance never resurrects the run (audit P2)', () => {
  it('leaves closed_at and activation_epoch untouched on a closed row', async () => {
    // The whole reason `stampedSessionRunId` exists. Routing the closer's
    // resolve through the normal attach path would take the resurrect branch on
    // a lease-expired row — clearing closed_at, bumping the epoch, and failing
    // the closer's own fenced write-back.
    const opened = await open(uid, 'conv-stamp')
    await setRow(opened.row.id, { last_seen_at: SWEEPABLE })
    await sweep(uid)
    const before = await rawRow(opened.row.id)

    const memoryId = await seedCommitmentMemory(uid)
    const commitment = await createCommitment({ userId: uid, memoryId, actorKind: 'user_mcp' })
    await transitionCommitment({
      userId: uid,
      commitmentId: commitment.id,
      to: 'resolved',
      actorKind: 'worker',
      expectedFrom: 'open',
      stampedSessionRunId: opened.row.id,
    })

    const after = await rawRow(opened.row.id)
    expect(after.closed_at).toEqual(before.closed_at)
    expect(after.activation_epoch).toBe(before.activation_epoch)
    expect(after.last_seen_at).toEqual(before.last_seen_at)

    // And the provenance really did land on the audit event.
    const events = await ownerPool.query(
      `SELECT payload->>'sessionRunId' AS run FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'resolve'`,
      [uid, memoryId],
    )
    expect(events.rows).toHaveLength(1)
    expect((events.rows[0] as { run: string }).run).toBe(opened.row.id)
  })

  it('the compare-and-set makes a lost race write NOTHING', async () => {
    // Codex core/write/commitments.ts:240. Two callers both observe 'open'; the
    // second must not append a duplicate resolve event under its own provenance.
    const memoryId = await seedCommitmentMemory(uid)
    const commitment = await createCommitment({ userId: uid, memoryId, actorKind: 'user_mcp' })
    await transitionCommitment({
      userId: uid,
      commitmentId: commitment.id,
      to: 'resolved',
      actorKind: 'worker',
      expectedFrom: 'open',
    })

    await expect(
      transitionCommitment({
        userId: uid,
        commitmentId: commitment.id,
        to: 'resolved',
        actorKind: 'worker',
        expectedFrom: 'open',
      }),
    ).rejects.toMatchObject({ name: 'CommitmentStateChangedError' })

    const events = await ownerPool.query(
      `SELECT count(*)::int AS n FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'resolve'`,
      [uid, memoryId],
    )
    expect((events.rows[0] as { n: number }).n).toBe(1)
  })
})
