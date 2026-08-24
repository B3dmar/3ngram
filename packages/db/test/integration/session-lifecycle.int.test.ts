// SPDX-License-Identifier: Apache-2.0
// Hook-facing session lifecycle against a real DB with the runtime role and real
// RLS (docs/concepts/session-continuity.mdx layers 1 and 6). What the fake-tx
// unit suite cannot reach: the unique natural key, the column defaults, the
// GREATEST floor evaluated by Postgres, the FOR UPDATE re-read against real
// grants, and tenant isolation on a key another tenant also uses.
//
// The attach-vs-close ordering itself is pinned by the fake-tx suites
// (session-provenance.test.ts, session-lifecycle.test.ts) — a real
// two-transaction race is not deterministic and a timing-based test here would
// be a flake, which hard rule 4 forbids.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eraseAccountData } from '../../src/account-delete.js'
import { withTenant } from '../../src/client.js'
import { isUniqueViolation } from '../../src/pg-errors.js'
import { agentSessions } from '../../src/schema/agent-sessions.js'
import {
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  closeSession,
  heartbeatSession,
  openSession,
  readAgentSession,
} from '../../src/session-lifecycle.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')
const LATER = new Date(NOW.getTime() + 60_000)
const STALE = new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000)
const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

let uid: string
let other: string

const open = (userId: string, input: Record<string, unknown>, now = NOW) =>
  withTenant(userId, (tx) =>
    openSession(
      tx,
      userId,
      { selector: { kind: 'all' }, ...input } as Parameters<typeof openSession>[2],
      now,
    ),
  )

const close = (userId: string, key = KEY, now = NOW) =>
  withTenant(userId, (tx) => closeSession(tx, userId, key, now))

const beat = (userId: string, input: Record<string, unknown> = KEY, now = NOW) =>
  withTenant(userId, (tx) =>
    heartbeatSession(tx, userId, input as Parameters<typeof heartbeatSession>[2], now),
  )

const read = (userId: string, key = KEY) =>
  withTenant(userId, (tx) => readAgentSession(tx, userId, key))

async function rawRow(id: string): Promise<Record<string, unknown>> {
  const r = await ownerPool.query('SELECT * FROM agent_sessions WHERE id = $1', [id])
  return r.rows[0] as Record<string, unknown>
}

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('sess-lifecycle@test.local')
  other = await seedUser('sess-lifecycle-other@test.local')
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('openSession', () => {
  it('inserts a startup row at epoch 1 and stamps the briefing', async () => {
    const briefedMemories = [
      { id: '01890b6e-0000-7000-8000-0000000000c1', topic: 'ship 5a', status: 'open' },
    ]
    const result = await open(uid, {
      ...KEY,
      source: 'startup',
      project: '3ngram',
      scope: 'work',
      briefedMemories,
    })

    expect(result.created).toBe(true)
    expect(result.reopened).toBe(false)
    expect(result.row.activationEpoch).toBe(1)
    expect(result.row.briefedMemories).toEqual(briefedMemories)
    expect(result.row.briefingDeliveredAt?.toISOString()).toBe(NOW.toISOString())
    expect(result.row.closedAt).toBeNull()
    // Bookkeeping only: triage starts idle with an empty watermark.
    const raw = await rawRow(result.row.id)
    expect(raw.triage_status).toBe('idle')
    expect(raw.last_triaged_event_ids).toEqual([])
  })

  it('is idempotent for a duplicate startup delivery: no epoch bump, no restamp', async () => {
    const first = await open(uid, { ...KEY, source: 'startup', project: '3ngram' })
    const again = await open(
      uid,
      { ...KEY, source: 'startup', project: '3ngram', briefedMemories: [] },
      LATER,
    )

    expect(again.row.id).toBe(first.row.id)
    expect(again.created).toBe(false)
    expect(again.row.activationEpoch).toBe(1)
    // The second delivery showed the agent nothing new, so the stamp stands.
    expect(again.row.briefingDeliveredAt).toBeNull()
    expect(again.row.briefedMemories).toEqual([])
    expect(again.row.lastSeenAt.toISOString()).toBe(LATER.toISOString())
  })

  it('409s a startup reusing the natural key with different identity params', async () => {
    await open(uid, { ...KEY, source: 'startup', project: '3ngram' })

    await expect(
      open(uid, { ...KEY, source: 'startup', project: 'other-repo' }),
    ).rejects.toBeInstanceOf(AgentSessionParamsConflictError)
    // Nothing moved: the live session keeps its row.
    expect((await read(uid))?.project).toBe('3ngram')
  })

  it('advances the epoch on resume and leaves the briefing alone', async () => {
    const briefedMemories = [
      { id: '01890b6e-0000-7000-8000-0000000000c1', topic: 'ship 5a', status: 'open' },
    ]
    const first = await open(uid, { ...KEY, source: 'startup', project: '3ngram', briefedMemories })

    const resumed = await open(uid, { ...KEY, source: 'resume' }, LATER)

    expect(resumed.row.id).toBe(first.row.id)
    expect(resumed.row.activationEpoch).toBe(2)
    expect(resumed.row.briefedMemories).toEqual(briefedMemories)
    expect(resumed.row.briefingDeliveredAt?.toISOString()).toBe(NOW.toISOString())
    // resume does NOT rewrite the row's frozen identity.
    expect(resumed.row.source).toBe('startup')
    expect(resumed.row.project).toBe('3ngram')
  })

  it('reopens an explicitly closed row on resume', async () => {
    await open(uid, { ...KEY, source: 'startup', project: '3ngram' })
    await close(uid)

    const resumed = await open(uid, { ...KEY, source: 'resume' }, LATER)

    expect(resumed.reopened).toBe(true)
    expect(resumed.row.closedAt).toBeNull()
    expect(resumed.row.activationEpoch).toBe(2)
  })

  it('resets a stale closer backoff on resume — the PRIMARY resurrect path (issue #184 audit F1)', async () => {
    // The failure scenario the audit named: an outage drives a row to
    // count=5/next=T+4h; the user resumes (this path, not the closer's own
    // write-time attach) and works for a while; the session closes again
    // minutes later. Without this reset the fresh candidate would still carry
    // the 4-hour gate from the PREVIOUS activation.
    const opened = await open(uid, { ...KEY, source: 'startup', project: '3ngram' })
    await close(uid)
    await ownerPool.query(
      'UPDATE agent_sessions SET closer_failure_count = 5, closer_next_attempt_at = $2 WHERE id = $1',
      [opened.row.id, new Date(LATER.getTime() + 4 * 60 * 60 * 1000)],
    )

    const resumed = await open(uid, { ...KEY, source: 'resume' }, LATER)

    expect(resumed.reopened).toBe(true)
    const row = await rawRow(opened.row.id)
    expect(row.closer_failure_count).toBe(0)
    expect(row.closer_next_attempt_at).toBeNull()
  })

  it('reopens a lease-expired row even though closed_at is still null', async () => {
    await open(uid, { ...KEY, source: 'startup', project: '3ngram' }, STALE)

    const resumed = await open(uid, { ...KEY, source: 'startup', project: '3ngram' }, NOW)

    expect(resumed.reopened).toBe(true)
    expect(resumed.row.activationEpoch).toBe(2)
  })

  it('restamps the briefing when a STARTUP reopens, and not when a resume does', async () => {
    const first = [{ id: '01890b6e-0000-7000-8000-0000000000c1', topic: 'old', status: 'open' }]
    const second = [{ id: '01890b6e-0000-7000-8000-0000000000c2', topic: 'new', status: 'open' }]
    await open(uid, { ...KEY, source: 'startup', briefedMemories: first })
    await close(uid)

    // Every startup renders and truncates a briefing, so the reopen records what
    // survived THAT cut — not a previous activation's delivery.
    const restarted = await open(uid, { ...KEY, source: 'startup', briefedMemories: second }, LATER)
    expect(restarted.reopened).toBe(true)
    expect(restarted.row.briefedMemories).toEqual(second)
    expect(restarted.row.briefingDeliveredAt?.toISOString()).toBe(LATER.toISOString())

    // resume is an activation, not a delivery: it never restamps.
    await close(uid, KEY, LATER)
    const resumed = await open(uid, { ...KEY, source: 'resume', briefedMemories: first }, LATER)
    expect(resumed.reopened).toBe(true)
    expect(resumed.row.briefedMemories).toEqual(second)
    expect(resumed.row.briefingDeliveredAt?.toISOString()).toBe(LATER.toISOString())
  })

  it('maps a natural-key unique violation to the params conflict, not a raw driver error', async () => {
    // DETERMINISTIC, not timing-based. Two opens of the same natural key with
    // DIFFERENT projects hold DIFFERENT attach keys, so neither blocks the
    // other. A inserts and holds its transaction open; B's row-locked read
    // cannot see the uncommitted row, so B reaches its INSERT and collides on
    // agent_sessions_natural_key the moment A commits.
    let inserted: () => void = () => undefined
    let release: () => void = () => undefined
    const aInserted = new Promise<void>((resolve) => {
      inserted = resolve
    })
    const aHeld = new Promise<void>((resolve) => {
      release = resolve
    })

    const txA = withTenant(uid, async (tx) => {
      await openSession(
        tx,
        uid,
        { ...KEY, source: 'startup', project: 'repo-a', selector: { kind: 'all' } },
        NOW,
      )
      inserted()
      await aHeld
    })
    await aInserted

    const txB = open(uid, { ...KEY, source: 'startup', project: 'repo-b' })
    release()

    await expect(txB).rejects.toBeInstanceOf(AgentSessionParamsConflictError)
    await txA
  })

  it('isUniqueViolation matches the REAL driver error for this constraint', async () => {
    // The other half of the proof above: the predicate is SQLSTATE-based, and
    // this pins that drizzle's wrapping of an agent_sessions_natural_key
    // violation is a shape it actually recognises.
    await open(uid, { ...KEY, source: 'startup' })
    const caught = await withTenant(uid, (tx) =>
      tx
        .insert(agentSessions)
        .values({
          userId: uid,
          agent: KEY.agent,
          sessionId: KEY.sessionId,
          source: 'startup',
          selector: { kind: 'all' as const },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    )

    expect(caught).toBeDefined()
    expect(isUniqueViolation(caught)).toBe(true)
  })

  it('never moves last_seen_at backwards (GREATEST floor)', async () => {
    await open(uid, { ...KEY, source: 'startup', project: '3ngram' }, LATER)

    const behind = await open(uid, { ...KEY, source: 'resume' }, NOW)

    expect(behind.row.lastSeenAt.toISOString()).toBe(LATER.toISOString())
  })

  it('keeps two tenants using the SAME natural key on separate rows', async () => {
    const mine = await open(uid, { ...KEY, source: 'startup', project: '3ngram' })
    const theirs = await open(other, { ...KEY, source: 'startup', project: 'their-repo' })

    expect(theirs.created).toBe(true)
    expect(theirs.row.id).not.toBe(mine.row.id)
    expect((await read(uid))?.project).toBe('3ngram')
    expect((await read(other))?.project).toBe('their-repo')
  })

  it('separates rows by agent as well as by conversation id', async () => {
    const claude = await open(uid, { ...KEY, source: 'startup' })
    const codex = await open(uid, { ...KEY, agent: 'codex', source: 'startup' })

    expect(codex.created).toBe(true)
    expect(codex.row.id).not.toBe(claude.row.id)
  })
})

describe('closeSession', () => {
  it('stamps closed_at and freezes last_seen_at', async () => {
    const opened = await open(uid, { ...KEY, source: 'startup', project: '3ngram' })

    const closed = await close(uid, KEY, LATER)

    expect(closed.alreadyClosed).toBe(false)
    expect(closed.closedAt.toISOString()).toBe(LATER.toISOString())
    expect(closed.row.closedAt?.toISOString()).toBe(LATER.toISOString())
    // Frozen: closed_at <= last_seen_at + lease is what identifies an explicit
    // close forever, so close must not refresh the lease.
    expect(closed.row.lastSeenAt.toISOString()).toBe(opened.row.lastSeenAt.toISOString())
  })

  it('is idempotent — a repeat close keeps the FIRST timestamp', async () => {
    await open(uid, { ...KEY, source: 'startup' })
    const first = await close(uid, KEY, NOW)

    const again = await close(uid, KEY, LATER)

    expect(again.alreadyClosed).toBe(true)
    expect(again.closedAt.toISOString()).toBe(first.closedAt.toISOString())
    expect(again.row.closedAt?.toISOString()).toBe(first.row.closedAt?.toISOString())
  })

  it('reports a REOPENED row as a fresh close, never as already closed', async () => {
    // The old zero-row fallback inferred "already closed" from a missed guarded
    // UPDATE; a row that was closed and then resurrected is live again, and a
    // close of it is a first close.
    await open(uid, { ...KEY, source: 'startup' })
    await close(uid, KEY, NOW)
    await beat(uid, KEY, LATER)

    const second = await close(uid, KEY, LATER)

    expect(second.alreadyClosed).toBe(false)
    expect(second.closedAt.toISOString()).toBe(LATER.toISOString())
  })

  it('does not clear the excerpt the closer has not consumed yet', async () => {
    await open(uid, { ...KEY, source: 'startup' })
    await beat(uid, { ...KEY, lastMessageExcerpt: 'shipped the router' })

    const closed = await close(uid)

    expect((await rawRow(closed.row.id)).last_message_excerpt).toBe('shipped the router')
  })

  it('throws for a natural key this tenant owns no row for', async () => {
    await expect(close(uid)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
  })

  it('cannot close another tenant row carrying the same natural key', async () => {
    const mine = await open(uid, { ...KEY, source: 'startup' })

    await expect(close(other)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
    expect((await rawRow(mine.row.id)).closed_at).toBeNull()
  })
})

describe('heartbeatSession', () => {
  it('refreshes the lease without advancing the epoch', async () => {
    const opened = await open(uid, { ...KEY, source: 'startup' })

    const result = await beat(uid, KEY, LATER)

    expect(result.resurrected).toBe(false)
    expect(result.row.activationEpoch).toBe(opened.row.activationEpoch)
    expect(result.row.lastSeenAt.toISOString()).toBe(LATER.toISOString())
  })

  it('is monotonic: a heartbeat with an older clock cannot shorten the lease', async () => {
    await open(uid, { ...KEY, source: 'startup' }, LATER)

    const behind = await beat(uid, KEY, NOW)

    expect(behind.row.lastSeenAt.toISOString()).toBe(LATER.toISOString())
  })

  it('stores the bounded excerpt and leaves it alone when none is sent', async () => {
    await open(uid, { ...KEY, source: 'startup' })
    await beat(uid, { ...KEY, lastMessageExcerpt: 'turn one' })

    await beat(uid, KEY, LATER)

    const row = await read(uid)
    expect((await rawRow(row?.id as string)).last_message_excerpt).toBe('turn one')
  })

  it('resurrects an explicitly closed row — a stale close is transient', async () => {
    const opened = await open(uid, { ...KEY, source: 'startup' })
    await close(uid)
    // A stale closer backoff from the activation that just ended (issue #184
    // audit F1) — Stop's own resurrect branch (`refreshLease`) must clear it
    // too, not just the write-time attach path.
    await ownerPool.query(
      'UPDATE agent_sessions SET closer_failure_count = 3, closer_next_attempt_at = $2 WHERE id = $1',
      [opened.row.id, new Date(LATER.getTime() + 60 * 60 * 1000)],
    )

    const result = await beat(uid, KEY, LATER)

    expect(result.resurrected).toBe(true)
    expect(result.row.closedAt).toBeNull()
    expect(result.row.activationEpoch).toBe(2)
    const row = await rawRow(opened.row.id)
    expect(row.closer_failure_count).toBe(0)
    expect(row.closer_next_attempt_at).toBeNull()
  })

  it('resurrects a lease-expired row and advances the epoch once', async () => {
    await open(uid, { ...KEY, source: 'startup' }, STALE)

    const first = await beat(uid, KEY, NOW)
    const second = await beat(uid, KEY, LATER)

    expect(first.resurrected).toBe(true)
    expect(first.row.activationEpoch).toBe(2)
    // The row is live again, so the next heartbeat is an ordinary refresh.
    expect(second.resurrected).toBe(false)
    expect(second.row.activationEpoch).toBe(2)
  })

  it('throws for a natural key this tenant owns no row for', async () => {
    await expect(beat(uid)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
  })

  it('refuses to write an excerpt back onto an ERASED account', async () => {
    // Erasure must be the FINAL content write (account-delete.ts). A heartbeat
    // that arrives after it — the in-flight request whose credentials were
    // revoked mid-flight — must not restore user content onto the tombstone.
    const opened = await open(uid, { ...KEY, source: 'startup' })
    await beat(uid, { ...KEY, lastMessageExcerpt: 'before erasure' })
    await withTenant(uid, (tx) => eraseAccountData(tx, uid, NOW))
    const erased = (await rawRow(opened.row.id)).last_message_excerpt

    const after = await beat(uid, { ...KEY, lastMessageExcerpt: 'after erasure' }, LATER)

    expect((await rawRow(opened.row.id)).last_message_excerpt).toBe(erased)
    expect((await rawRow(opened.row.id)).last_message_excerpt).not.toBe('after erasure')
    // The lease is structural skeleton erasure preserves, so the rest still lands.
    expect(after.row.lastSeenAt.toISOString()).toBe(LATER.toISOString())
  })

  it('still stores the excerpt for a live account (the guard is not a blanket refusal)', async () => {
    const opened = await open(uid, { ...KEY, source: 'startup' })

    await beat(uid, { ...KEY, lastMessageExcerpt: 'live account' })

    expect((await rawRow(opened.row.id)).last_message_excerpt).toBe('live account')
  })

  it('cannot heartbeat another tenant row carrying the same natural key', async () => {
    const mine = await open(uid, { ...KEY, source: 'startup' })

    await expect(beat(other)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
    expect((await rawRow(mine.row.id)).activation_epoch).toBe(1)
  })
})

describe('readAgentSession', () => {
  it('returns the briefed rows the debrief render inlines, and writes nothing', async () => {
    const briefedMemories = [
      { id: '01890b6e-0000-7000-8000-0000000000c1', topic: 'ship 5a', status: 'open' },
    ]
    const opened = await open(uid, { ...KEY, source: 'startup', briefedMemories })

    const row = await read(uid)

    expect(row?.briefedMemories).toEqual(briefedMemories)
    // Rendering a prompt must not refresh a lease as a side effect.
    expect(row?.lastSeenAt.toISOString()).toBe(opened.row.lastSeenAt.toISOString())
  })

  it('is undefined for another tenant natural key (RLS)', async () => {
    await open(uid, { ...KEY, source: 'startup' })

    expect(await read(other)).toBeUndefined()
  })
})
