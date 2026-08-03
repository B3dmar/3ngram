// SPDX-License-Identifier: Apache-2.0
// Briefing/handoff orientation read layer exercised through
// the RUNTIME role via withTenant() — the production path. Owner bypasses RLS and
// would prove nothing (docs/concepts/testing.mdx). Rows are seeded directly (owner connection),
// precedent: facts-read.int.test.ts / search.int.test.ts.
//
// Proves the query-layer invariants unit tests (mocked db) cannot:
//   - open/waiting commitments join their LIVE riding memory, ordered by urgency
//   - blocker/decision/preference sections filter by type AND liveness AND status
//   - stale candidates filter by updated_at < cutoff AND the caller's type allowlist
//   - every list is BOUNDED by its limit (no-firehose)
//   - RLS scopes every read to the tenant (tenant isolation)
//
// SINGLE-STATEMENT EXACT COUNT (Codex P2, comment 3372242177): each section query
// returns BOTH its capped `items` AND the exact `totalCount` from a `count(*)
// OVER()` window in ONE statement. That single statement runs against ONE snapshot,
// so `totalCount` is provably consistent with the slice it ships with — unlike a
// SEPARATE COUNT(*), which under READ COMMITTED (client.ts default) would take its
// own snapshot and could diverge if a concurrent write landed between the two
// reads. These tests assert the contract: `totalCount` is the full predicate total
// even when `items` is capped at the limit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  activeBlockers,
  activePreferences,
  openCommitments,
  overdueCommitments,
  recentDecisions,
  staleCandidates,
} from '../../src/briefing-read.js'
import { withTenant } from '../../src/client.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

let memCounter = 0

/** Seed a live memory (owner connection); returns its id. */
async function seedMemory(
  userId: string,
  memoryType: string,
  opts: { scope?: string; project?: string | null; updatedAt?: string; status?: string } = {},
): Promise<string> {
  memCounter += 1
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope, project, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
     RETURNING id`,
    [
      userId,
      memoryType,
      `topic-${memCounter}`,
      `content-${memCounter}`,
      `briefing-${userId}-${memCounter}`,
      opts.scope ?? 'work',
      opts.project ?? null,
      opts.status ?? 'active',
      opts.updatedAt ?? null,
    ],
  )
  return r.rows[0].id
}

/** Seed a commitment riding `memoryId` (owner connection). */
async function seedCommitment(
  userId: string,
  memoryId: string,
  opts: { status?: string; dueAt?: string | null; nextSurfacingAt?: string | null } = {},
): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO commitments (user_id, memory_id, status, due_at, next_surfacing_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz) RETURNING id`,
    [userId, memoryId, opts.status ?? 'open', opts.dueAt ?? null, opts.nextSurfacingAt ?? null],
  )
  return r.rows[0].id
}

beforeAll(async () => {
  userA = await seedUser('briefing-a@test.local')
  userB = await seedUser('briefing-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

const ALL = { kind: 'all' } as const

// Mirrors core's STALE_CANDIDATE_TYPES policy constant (packages/core cannot be
// imported here — db must not depend on core). The query layer takes the list
// as a parameter; this suite proves the SQL honours whatever allowlist it gets.
const STALE_TYPES = ['decision', 'preference', 'blocker', 'fact'] as const

describe('openCommitments (runtime role, real withTenant)', () => {
  it('returns open + waiting commitments joined to their live memory, excludes resolved', async () => {
    const m1 = await seedMemory(userA, 'commitment')
    const m2 = await seedMemory(userA, 'commitment')
    const m3 = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, m1, { status: 'open' })
    await seedCommitment(userA, m2, { status: 'waiting' })
    await seedCommitment(userA, m3, { status: 'resolved' })

    const page = await withTenant(userA, (tx) => openCommitments(tx, userA, ALL, 25))
    const ids = page.items.map((r) => r.memoryId)
    expect(ids).toContain(m1)
    expect(ids).toContain(m2)
    expect(ids).not.toContain(m3)
  })

  it('narrows by scope and bounds by limit', async () => {
    const work = await seedMemory(userA, 'commitment', { scope: 'work' })
    const personal = await seedMemory(userA, 'commitment', { scope: 'personal' })
    await seedCommitment(userA, work)
    await seedCommitment(userA, personal)

    const scoped = await withTenant(userA, (tx) =>
      openCommitments(tx, userA, { kind: 'scope', scope: 'work' }, 25),
    )
    expect(scoped.items.map((r) => r.memoryId)).toEqual([work])

    // Seed enough to test the limit clause.
    for (let i = 0; i < 3; i += 1) {
      const m = await seedMemory(userA, 'commitment', { scope: 'work' })
      await seedCommitment(userA, m)
    }
    const bounded = await withTenant(userA, (tx) =>
      openCommitments(tx, userA, { kind: 'scope', scope: 'work' }, 2),
    )
    expect(bounded.items).toHaveLength(2)
  })

  it('RLS isolates: B does not see A commitments', async () => {
    const m = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, m)
    const page = await withTenant(userB, (tx) => openCommitments(tx, userB, ALL, 25))
    expect(page.items).toHaveLength(0)
    expect(page.totalCount).toBe(0)
  })

  it('excludes an archived-but-not-superseded commitment (status liveness, valid_to NULL)', async () => {
    // The riding memory is archived (status != 'active') yet NOT superseded
    // (valid_to IS NULL). Without the status check this would still surface,
    // contradicting the two-condition liveness the rest of the module enforces.
    const live = await seedMemory(userA, 'commitment', { status: 'active' })
    const archived = await seedMemory(userA, 'commitment', { status: 'archived' })
    await seedCommitment(userA, live, { status: 'open' })
    await seedCommitment(userA, archived, { status: 'open' })

    const page = await withTenant(userA, (tx) => openCommitments(tx, userA, ALL, 25))
    const ids = page.items.map((r) => r.memoryId)
    expect(ids).toContain(live)
    expect(ids).not.toContain(archived)
  })
})

describe('overdueCommitments (runtime role)', () => {
  const NOW = new Date('2026-06-06T12:00:00.000Z')
  const PAST = '2026-06-01T00:00:00.000Z'
  const FUTURE = '2026-07-01T00:00:00.000Z'

  it('returns past-due open/waiting commitments, ordered most-overdue first', async () => {
    const earlier = await seedMemory(userA, 'commitment')
    const later = await seedMemory(userA, 'commitment')
    const future = await seedMemory(userA, 'commitment')
    const noDue = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, earlier, { dueAt: '2026-05-01T00:00:00.000Z' })
    await seedCommitment(userA, later, { dueAt: PAST })
    await seedCommitment(userA, future, { dueAt: FUTURE })
    await seedCommitment(userA, noDue, { dueAt: null })

    const page = await withTenant(userA, (tx) => overdueCommitments(tx, userA, ALL, NOW, 25))
    // Only the two past-due; ordered by due_at ASC (most overdue leads).
    expect(page.items.map((r) => r.memoryId)).toEqual([earlier, later])
  })

  it('excludes resolved and archived-riding-memory commitments (liveness)', async () => {
    const resolvedMem = await seedMemory(userA, 'commitment')
    const archivedMem = await seedMemory(userA, 'commitment', { status: 'archived' })
    await seedCommitment(userA, resolvedMem, { status: 'resolved', dueAt: PAST })
    await seedCommitment(userA, archivedMem, { status: 'open', dueAt: PAST })

    const page = await withTenant(userA, (tx) => overdueCommitments(tx, userA, ALL, NOW, 25))
    expect(page.items).toHaveLength(0)
    expect(page.totalCount).toBe(0)
  })

  it('P1: an overdue commitment sorting AFTER the general cap is still surfaced, count exact', async () => {
    // Seed CAP+1 open commitments. The OVERDUE one is given the LATEST surfacing
    // instant so it sorts LAST in openCommitments (ordered by next_surfacing_at);
    // every other commitment surfaces sooner and is NOT overdue. With a cap of CAP,
    // the general slice drops the overdue row — the Codex P1 bug. The dedicated
    // overdue query must still surface it, and the count must be exact (= 1).
    const CAP = 25
    // Inserts are independent; sort order is driven by the deterministic
    // next_surfacing_at values below, not insertion order, so seed in parallel
    // to cut wall time against remote Neon.
    await Promise.all(
      Array.from({ length: CAP }, async (_, i) => {
        const m = await seedMemory(userA, 'commitment')
        // Sooner surfacing than the overdue row, future due (not overdue).
        await seedCommitment(userA, m, {
          dueAt: FUTURE,
          nextSurfacingAt: `2026-06-06T0${i % 9}:00:00.000Z`,
        })
      }),
    )
    const overdueMem = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, overdueMem, {
      dueAt: PAST,
      // Latest surfacing → sorts last in the general ordering → dropped by the cap.
      nextSurfacingAt: '2026-12-31T23:59:00.000Z',
    })

    // The general slice, capped at CAP, must NOT contain the overdue commitment.
    const general = await withTenant(userA, (tx) => openCommitments(tx, userA, ALL, CAP))
    expect(general.items).toHaveLength(CAP)
    expect(general.items.map((r) => r.memoryId)).not.toContain(overdueMem)

    // The dedicated overdue query surfaces it regardless of the general cap, and
    // ships the exact total in the SAME statement.
    const overdue = await withTenant(userA, (tx) => overdueCommitments(tx, userA, ALL, NOW, CAP))
    expect(overdue.items.map((r) => r.memoryId)).toContain(overdueMem)
    expect(overdue.totalCount).toBe(1)
  })

  it('narrows by scope and bounds the list by limit; totalCount is unbounded-exact', async () => {
    for (let i = 0; i < 3; i += 1) {
      const m = await seedMemory(userA, 'commitment', { scope: 'work' })
      await seedCommitment(userA, m, { dueAt: PAST })
    }
    const personal = await seedMemory(userA, 'commitment', { scope: 'personal' })
    await seedCommitment(userA, personal, { dueAt: PAST })

    const scoped = { kind: 'scope', scope: 'work' } as const
    // List capped at 2, but the window count in the SAME statement reports all 3.
    const bounded = await withTenant(userA, (tx) => overdueCommitments(tx, userA, scoped, NOW, 2))
    expect(bounded.items).toHaveLength(2)
    expect(bounded.totalCount).toBe(3)
  })

  it('RLS isolates: B does not see A overdue commitments', async () => {
    const m = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, m, { dueAt: PAST })
    const page = await withTenant(userB, (tx) => overdueCommitments(tx, userB, ALL, NOW, 25))
    expect(page.items).toHaveLength(0)
    expect(page.totalCount).toBe(0)
  })
})

describe('typed memory sections (runtime role)', () => {
  it('activeBlockers returns only live active blocker-type memories', async () => {
    const blocker = await seedMemory(userA, 'blocker')
    await seedMemory(userA, 'decision')
    await seedMemory(userA, 'blocker', { status: 'archived' })
    const page = await withTenant(userA, (tx) => activeBlockers(tx, userA, ALL, 25))
    expect(page.items.map((r) => r.id)).toEqual([blocker])
  })

  it('recentDecisions and activePreferences filter by their type', async () => {
    const decision = await seedMemory(userA, 'decision')
    const preference = await seedMemory(userA, 'preference')
    const decisions = await withTenant(userA, (tx) => recentDecisions(tx, userA, ALL, 25))
    const preferences = await withTenant(userA, (tx) => activePreferences(tx, userA, ALL, 25))
    expect(decisions.items.map((r) => r.id)).toEqual([decision])
    expect(preferences.items.map((r) => r.id)).toEqual([preference])
  })
})

describe('staleCandidates (runtime role)', () => {
  it('returns allowlisted memories untouched before the cutoff, excluding commitments', async () => {
    const cutoff = '2026-01-01T00:00:00.000Z'
    const stale = await seedMemory(userA, 'fact', { updatedAt: '2025-06-01T00:00:00.000Z' })
    const fresh = await seedMemory(userA, 'fact', { updatedAt: '2026-06-01T00:00:00.000Z' })
    // A stale-but-commitment memory must NOT surface here (own list).
    const staleCommitment = await seedMemory(userA, 'commitment', {
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    await seedCommitment(userA, staleCommitment)

    const page = await withTenant(userA, (tx) =>
      staleCandidates(tx, userA, ALL, new Date(cutoff), 25, STALE_TYPES),
    )
    const ids = page.items.map((r) => r.id)
    expect(ids).toContain(stale)
    expect(ids).not.toContain(fresh)
    expect(ids).not.toContain(staleCommitment)
  })

  it('type allowlist: of all 8 types stale, exactly the reviewable 4 surface (issue #44)', async () => {
    // One stale row per memory type. The predicate is memory_type IN (allowlist):
    // decision/preference/blocker/fact are IN; commitment/pattern/note/event are
    // OUT — the imported event/note rows that flooded the prod briefing stay out.
    const allTypes = [
      'decision',
      'commitment',
      'blocker',
      'fact',
      'preference',
      'pattern',
      'note',
      'event',
    ] as const
    const seeded = new Map<string, string>()
    for (const t of allTypes) {
      seeded.set(t, await seedMemory(userA, t, { updatedAt: '2025-06-01T00:00:00.000Z' }))
    }

    const page = await withTenant(userA, (tx) =>
      staleCandidates(tx, userA, ALL, new Date('2026-01-01T00:00:00.000Z'), 25, STALE_TYPES),
    )
    const ids = new Set(page.items.map((r) => r.id))
    for (const t of STALE_TYPES) {
      expect(ids.has(seeded.get(t) as string), `${t} should be a stale candidate`).toBe(true)
    }
    for (const t of ['commitment', 'pattern', 'note', 'event']) {
      expect(ids.has(seeded.get(t) as string), `${t} should NOT be a stale candidate`).toBe(false)
    }
    expect(page.totalCount).toBe(STALE_TYPES.length)
  })

  it('back-compat: omitting memoryTypes keeps the legacy NOT-commitment filter', async () => {
    // A 0.6.2 positional caller passes five args (no allowlist). That call must
    // keep its exact prior semantics: every non-commitment stale row surfaces,
    // including note/event (Codex P1, comment 3702700238).
    const staleNote = await seedMemory(userA, 'note', { updatedAt: '2025-06-01T00:00:00.000Z' })
    const staleCommitment = await seedMemory(userA, 'commitment', {
      updatedAt: '2025-06-01T00:00:00.000Z',
    })
    await seedCommitment(userA, staleCommitment)

    const page = await withTenant(userA, (tx) =>
      staleCandidates(tx, userA, ALL, new Date('2026-01-01T00:00:00.000Z'), 25),
    )
    const ids = page.items.map((r) => r.id)
    expect(ids).toContain(staleNote)
    expect(ids).not.toContain(staleCommitment)
  })

  it('RLS isolates: B does not see A stale memories', async () => {
    await seedMemory(userA, 'fact', { updatedAt: '2025-06-01T00:00:00.000Z' })
    const page = await withTenant(userB, (tx) =>
      staleCandidates(tx, userB, ALL, new Date('2026-01-01T00:00:00.000Z'), 25, STALE_TYPES),
    )
    expect(page.items).toHaveLength(0)
    expect(page.totalCount).toBe(0)
  })
})

describe('single-statement exact totalCount beyond the cap (runtime role, Codex P2 3372242177)', () => {
  // A tenant with MORE matching rows than the cap: the SAME statement that returns
  // the capped `items` ALSO carries `totalCount` = the TRUE total (a `count(*)
  // OVER()` window over the full predicate, evaluated before LIMIT). One statement
  // == one snapshot, so the count is provably consistent with the slice it ships
  // with. items length == cap; totalCount is exact.
  const CAP = 3
  const STALE_BEFORE = new Date('2026-01-01T00:00:00.000Z')
  const STALE_AT = '2025-06-01T00:00:00.000Z'

  it('openCommitments: totalCount is exact while items caps at the limit', async () => {
    await Promise.all(
      Array.from({ length: CAP + 2 }, async () => {
        const m = await seedMemory(userA, 'commitment')
        await seedCommitment(userA, m, { status: 'open' })
      }),
    )
    const page = await withTenant(userA, (tx) => openCommitments(tx, userA, ALL, CAP))
    expect(page.items).toHaveLength(CAP)
    expect(page.totalCount).toBe(CAP + 2)
  })

  it('activeBlockers: totalCount is exact while items caps at the limit', async () => {
    await Promise.all(Array.from({ length: CAP + 2 }, () => seedMemory(userA, 'blocker')))
    const page = await withTenant(userA, (tx) => activeBlockers(tx, userA, ALL, CAP))
    expect(page.items).toHaveLength(CAP)
    expect(page.totalCount).toBe(CAP + 2)
  })

  it('recentDecisions: totalCount is exact while items caps at the limit', async () => {
    await Promise.all(Array.from({ length: CAP + 2 }, () => seedMemory(userA, 'decision')))
    const page = await withTenant(userA, (tx) => recentDecisions(tx, userA, ALL, CAP))
    expect(page.items).toHaveLength(CAP)
    expect(page.totalCount).toBe(CAP + 2)
  })

  it('activePreferences: totalCount is exact while items caps at the limit', async () => {
    await Promise.all(Array.from({ length: CAP + 2 }, () => seedMemory(userA, 'preference')))
    const page = await withTenant(userA, (tx) => activePreferences(tx, userA, ALL, CAP))
    expect(page.items).toHaveLength(CAP)
    expect(page.totalCount).toBe(CAP + 2)
  })

  it('staleCandidates: totalCount is exact while items caps at the limit', async () => {
    await Promise.all(
      Array.from({ length: CAP + 2 }, () => seedMemory(userA, 'fact', { updatedAt: STALE_AT })),
    )
    const page = await withTenant(userA, (tx) =>
      staleCandidates(tx, userA, ALL, STALE_BEFORE, CAP, STALE_TYPES),
    )
    expect(page.items).toHaveLength(CAP)
    expect(page.totalCount).toBe(CAP + 2)
  })

  it('totalCount shares the list predicate: excludes superseded + archived rows', async () => {
    // A live blocker, an archived blocker, and a superseded (valid_to set) blocker.
    // Only the live one counts — the window count and the list use the SAME predicate
    // in the SAME statement.
    await seedMemory(userA, 'blocker', { status: 'active' })
    await seedMemory(userA, 'blocker', { status: 'archived' })
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, status, valid_to)
       VALUES ($1,'blocker','t','c',$2,'active', now())`,
      [userA, `briefing-superseded-${crypto.randomUUID()}`],
    )
    const page = await withTenant(userA, (tx) => activeBlockers(tx, userA, ALL, 25))
    expect(page.items).toHaveLength(1)
    expect(page.totalCount).toBe(1)
  })

  it('empty result yields totalCount 0 (no row to read the window from)', async () => {
    const page = await withTenant(userA, (tx) => activeBlockers(tx, userA, ALL, CAP))
    expect(page.items).toHaveLength(0)
    expect(page.totalCount).toBe(0)
  })

  it('RLS isolates the counts: B sees zero of A rows', async () => {
    const m = await seedMemory(userA, 'commitment')
    await seedCommitment(userA, m, { status: 'open' })
    await seedMemory(userA, 'blocker')
    const commitB = await withTenant(userB, (tx) => openCommitments(tx, userB, ALL, 25))
    const blockB = await withTenant(userB, (tx) => activeBlockers(tx, userB, ALL, 25))
    expect(commitB.totalCount).toBe(0)
    expect(blockB.totalCount).toBe(0)
  })
})
