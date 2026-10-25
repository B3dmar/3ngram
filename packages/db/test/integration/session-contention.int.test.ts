// SPDX-License-Identifier: Apache-2.0
// Real two-connection interleavings for the session-locking claims (issue #178,
// docs/concepts/session-continuity.mdx). Until this suite every one of these was
// pinned only by fake-tx replays, which cannot observe Postgres actually making a
// transaction wait.
//
// Each test CONSTRUCTS its interleaving with the barrier harness
// (./concurrency.ts): a test transaction takes the conflicting lock and parks,
// the production call starts on its own pooled runtime-role connection (app_user,
// real RLS), `pg_locks` proves it is blocked on exactly that lock, and only then
// is the holder released and committed state asserted. No sleeps pick a winner
// and nothing retries (hard rule 4).
//
// A production function's internal statements are never split by a test-only
// hook. Where a test needs a transaction "between" two statements it holds the
// lock the second one needs — usually the session row via SELECT ... FOR UPDATE —
// so the production call provably parks at that statement.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERASED_PII, eraseAccountData } from '../../src/account-delete.js'
import { lockSessionAttach, type TenantTx, withTenant } from '../../src/client.js'
import { writeMemory } from '../../src/memory-write.js'
import { closeSession, heartbeatSession, openSession } from '../../src/session-lifecycle.js'
import { resolveSessionProvenance } from '../../src/session-provenance.js'
import { assertPending, holdOpen, ROW_LOCK, releaseHeld, waitForLockWait } from './concurrency.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')
/** Lease expired relative to NOW: the next attach must resurrect. */
const STALE = new Date(NOW.getTime() - SESSION_LEASE_MS - 120_000)
/** A SessionEnd shortly after STALE: inside its lease, so an EXPLICIT close. */
const EXPLICIT_CLOSE_AT = new Date(STALE.getTime() + 60_000)
/** A sweeper's close: past STALE's lease, so IMPLICIT and resurrectable. */
const IMPLICIT_CLOSE_AT = new Date(STALE.getTime() + SESSION_LEASE_MS + 30_000)
const PROJECT = '3ngram'
const RUN = '01890b6e-0000-7000-8000-00000000c178'
const KEY = { agent: 'codex', sessionId: 'conv-contention' }

let uid: string
let seq = 0
const unique = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`

async function seedSession(opts: {
  id?: string
  sessionId?: string
  lastSeenAt: Date
  closedAt?: Date | null
}): Promise<string> {
  const id = opts.id ?? RUN
  await ownerPool.query(
    `INSERT INTO agent_sessions
       (id, user_id, agent, session_id, source, project, selector, last_seen_at, closed_at, activation_epoch)
     VALUES ($1, $2, $3, $4, 'startup', $5, '{"kind":"all"}'::jsonb, $6, $7, 1)`,
    [
      id,
      uid,
      KEY.agent,
      opts.sessionId ?? KEY.sessionId,
      PROJECT,
      opts.lastSeenAt,
      opts.closedAt ?? null,
    ],
  )
  return id
}

interface SessionState {
  closed_at: Date | null
  last_seen_at: Date
  activation_epoch: number
  project: string | null
  last_message_excerpt: string | null
}

/** COMMITTED state, read on the owner pool outside every test transaction. */
async function committed(id = RUN): Promise<SessionState> {
  const r = await ownerPool.query(
    `SELECT closed_at, last_seen_at, activation_epoch, project, last_message_excerpt
       FROM agent_sessions WHERE id = $1`,
    [id],
  )
  return r.rows[0] as SessionState
}

const attachKnown = (now = NOW) =>
  withTenant(uid, (tx) => resolveSessionProvenance(tx, uid, { sessionRunId: RUN, now }))

const attachOmitted = (now = NOW) =>
  withTenant(uid, (tx) => resolveSessionProvenance(tx, uid, { project: PROJECT, now }))

/** Park a transaction holding the session row's lock, as a pause point for others. */
const holdRow = (id = RUN) =>
  holdOpen(uid, (tx) => tx.execute(sql`SELECT 1 FROM agent_sessions WHERE id = ${id} FOR UPDATE`))

beforeEach(async () => {
  await resetDomainTables()
  // Unique per test: erasure tombstones the user's email, so a reused address
  // would seed a different user than the rows the test then inspects.
  uid = await seedUser(`${unique('contention')}@test.local`)
}, 120_000)

afterEach(releaseHeld)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('stale-run resurrection under concurrent writers (claim 1)', () => {
  it('advances activation_epoch ONCE when N writers carrying the same stale run id commit', async () => {
    await seedSession({ lastSeenAt: STALE })
    const writers = 4

    // Hold the attach lock for the row's project. Every writer takes its
    // unlocked first read (stale), then queues here — so all N have DECIDED the
    // row is stale before any of them can resurrect it.
    const holder = holdOpen(uid, (tx) => lockSessionAttach(tx, uid, PROJECT))
    await holder.ready

    const writes = Array.from({ length: writers }, () =>
      writeMemory({
        userId: uid,
        memoryType: 'note',
        topic: 'contention',
        content: unique('body'),
        scope: 'work',
        project: PROJECT,
        tags: [],
        contentHash: unique('hash'),
        actorKind: 'user_api',
        sessionRunId: RUN,
        now: NOW,
      }),
    )
    await waitForLockWait({ locktype: 'advisory', blockedBy: holder.pid, count: writers })
    for (const [index, write] of writes.entries()) await assertPending(write, `writer ${index}`)
    expect((await committed()).activation_epoch).toBe(1)

    await holder.commit()
    const written = await Promise.all(writes)

    const row = await committed()
    expect(row.activation_epoch).toBe(2)
    expect(row.closed_at).toBeNull()
    expect(row.last_seen_at.toISOString()).toBe(NOW.toISOString())
    // Every writer still attributed itself to the run: the losers heartbeat the
    // already-revived row instead of resurrecting it again.
    const payloads = await ownerPool.query(
      `SELECT payload FROM memory_events WHERE memory_id = ANY($1::uuid[]) AND event_kind = 'create'`,
      [written.map((w) => w.id)],
    )
    expect(payloads.rows.map((r) => r.payload)).toEqual(
      Array.from({ length: writers }, () => ({ sessionRunId: RUN })),
    )
  })
})

describe('attach vs explicit close (claim 2)', () => {
  it('a close holding the row makes the attach re-read wait, and the attach then honours it', async () => {
    await seedSession({ lastSeenAt: STALE })
    // SessionEnd runs and parks before commit, holding the row lock.
    const close = holdOpen(uid, (tx) => closeSession(tx, uid, KEY, EXPLICIT_CLOSE_AT))
    await close.ready

    // The attach saw the row stale and open (the close is uncommitted) and
    // reaches its FOR UPDATE re-read — which must wait for the close, not read
    // past it and resurrect.
    const attach = attachKnown()
    await waitForLockWait({ locktype: ROW_LOCK, blockedBy: close.pid })
    await assertPending(attach, 'attach')
    expect((await committed()).closed_at).toBeNull()

    await close.commit()
    expect(await attach).toBeUndefined()

    const row = await committed()
    expect(row.closed_at?.toISOString()).toBe(EXPLICIT_CLOSE_AT.toISOString())
    expect(row.activation_epoch).toBe(1)
  })

  it('a SessionEnd behind a resurrecting attach waits for it, then closes the revived row', async () => {
    // Implicitly closed (swept) and stale: the attach resurrects it.
    await seedSession({ lastSeenAt: STALE, closedAt: IMPLICIT_CLOSE_AT })
    const attach = holdOpen(uid, (tx) =>
      resolveSessionProvenance(tx, uid, { sessionRunId: RUN, now: NOW }),
    )
    expect(await attach.ready).toBe(RUN)

    // closeSession must decide on the row version the resurrect leaves, not on
    // the committed (still closed) one — else it reports "already closed" and
    // the revived conversation stays open after its SessionEnd.
    const closeAt = new Date(NOW.getTime() + 30_000)
    const close = withTenant(uid, (tx) => closeSession(tx, uid, KEY, closeAt))
    await waitForLockWait({ locktype: ROW_LOCK, blockedBy: attach.pid })
    await assertPending(close, 'close')

    await attach.commit()
    const closed = await close
    expect(closed.alreadyClosed).toBe(false)

    const row = await committed()
    expect(row.closed_at?.toISOString()).toBe(closeAt.toISOString())
    expect(row.activation_epoch).toBe(2)
  })
})

describe('omitted-id attach: zero/one/many holds at commit (claim 3)', () => {
  const openSecond = (tx: TenantTx) =>
    openSession(
      tx,
      uid,
      {
        agent: KEY.agent,
        sessionId: 'conv-second',
        source: 'startup',
        project: PROJECT,
        selector: { kind: 'all' },
      },
      NOW,
    )

  it('an in-flight open of a second session makes the attach wait, then count many', async () => {
    await seedSession({ lastSeenAt: NOW })
    const opener = holdOpen(uid, openSecond)
    await opener.ready

    const attach = attachOmitted()
    await waitForLockWait({ locktype: 'advisory', blockedBy: opener.pid })
    await assertPending(attach, 'attach')

    await opener.commit()
    // Two leased-open sessions in the project at commit: ambiguous, so the
    // write lands unattributed and refreshes neither lease.
    expect(await attach).toBeUndefined()
    expect((await committed()).last_seen_at.toISOString()).toBe(NOW.toISOString())
  })

  it('an attach that counted one holds that count until commit: a concurrent open queues', async () => {
    await seedSession({ lastSeenAt: NOW })
    const attach = holdOpen(uid, (tx) =>
      resolveSessionProvenance(tx, uid, { project: PROJECT, now: NOW }),
    )
    expect(await attach.ready).toBe(RUN)

    const opener = withTenant(uid, openSecond)
    await waitForLockWait({ locktype: 'advisory', blockedBy: attach.pid })
    await assertPending(opener, 'open')
    const open = await ownerPool.query(
      `SELECT count(*)::int AS n FROM agent_sessions WHERE user_id = $1 AND closed_at IS NULL`,
      [uid],
    )
    expect((open.rows[0] as { n: number }).n).toBe(1)

    await attach.commit()
    expect((await opener).created).toBe(true)
  })

  it('a close holding the only open row makes the attach wait, then attribute nothing', async () => {
    const seen = new Date(NOW.getTime() - 60_000)
    await seedSession({ lastSeenAt: seen })
    const close = holdOpen(uid, (tx) => closeSession(tx, uid, KEY, NOW))
    await close.ready

    const attach = attachOmitted()
    await waitForLockWait({ locktype: ROW_LOCK, blockedBy: close.pid })
    await assertPending(attach, 'attach')

    await close.commit()
    expect(await attach).toBeUndefined()
    // No heartbeat onto the session the tenant just ended.
    expect((await committed()).last_seen_at.toISOString()).toBe(seen.toISOString())
  })
})

describe('attach vs account erasure lock order (claim 4)', () => {
  it('an attach holding attach+row locks and an erasure holding the lifecycle lock both commit', async () => {
    await seedSession({ lastSeenAt: STALE })
    // Pause point: the attach takes the attach advisory lock and queues on the
    // row; erasure takes account-lifecycle EXCLUSIVE and queues on the same row
    // behind it. Released, the attach runs first while erasure holds its lock —
    // the interleaving a lifecycle request taken under the row lock deadlocks.
    const pause = holdRow()
    await pause.ready

    const attach = attachKnown()
    await waitForLockWait({ locktype: ROW_LOCK, blockedBy: pause.pid })
    const erase = withTenant(uid, (tx) => eraseAccountData(tx, uid, NOW))
    await waitForLockWait({ locktype: ROW_LOCK, count: 2 })
    await assertPending(attach, 'attach')
    await assertPending(erase, 'erase')

    await pause.commit()
    const [attached, erased] = await Promise.all([attach, erase])
    expect(attached).toBe(RUN)
    expect(erased?.agentSessions).toBe(1)

    const row = await committed()
    // One resurrection, then erasure's own fence bump; the project is redacted.
    expect(row.activation_epoch).toBe(3)
    expect(row.project).toBeNull()
  })
})

describe('heartbeat excerpt vs account erasure (claim 5)', () => {
  const EXCERPT = 'the agent said something'
  const beat = (now: Date) =>
    withTenant(uid, (tx) => heartbeatSession(tx, uid, { ...KEY, lastMessageExcerpt: EXCERPT }, now))

  it('a heartbeat holding the shared lifecycle lock makes erasure wait', async () => {
    await seedSession({ lastSeenAt: NOW })
    // Park the heartbeat AFTER it took the shared lock: it reaches its row
    // UPDATE and queues behind this row lock.
    const pause = holdRow()
    await pause.ready
    const heartbeat = beat(new Date(NOW.getTime() + 1_000))
    const [beatPid] = await waitForLockWait({ locktype: ROW_LOCK, blockedBy: pause.pid })

    const erase = withTenant(uid, (tx) => eraseAccountData(tx, uid, NOW))
    await waitForLockWait({ locktype: 'advisory', blockedBy: beatPid })
    await assertPending(erase, 'erase')

    await pause.commit()
    await heartbeat
    await erase
    // Erasure ran strictly after the content write, so it is the final one.
    expect((await committed()).last_message_excerpt).toBe(ERASED_PII)
  })

  it('a heartbeat waiting behind an uncommitted erasure drops its excerpt', async () => {
    await seedSession({ lastSeenAt: NOW })
    const erase = holdOpen(uid, (tx) => eraseAccountData(tx, uid, NOW))
    await erase.ready

    const heartbeat = beat(new Date(NOW.getTime() + 1_000))
    await waitForLockWait({ locktype: 'advisory', blockedBy: erase.pid })
    await assertPending(heartbeat, 'heartbeat')

    await erase.commit()
    await heartbeat
    expect((await committed()).last_message_excerpt).toBe(ERASED_PII)
  })
})
