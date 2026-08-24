// SPDX-License-Identifier: Apache-2.0
// The Stop-nudge handshake, pinned without a database (issue #166 step 7a;
// docs/concepts/session-continuity.mdx layer 4).
//
// Two things are asserted here, and neither needs Postgres:
//
//   1. THE ENTRY RULE AND THE DEBOUNCE, as a total matrix over
//      `triage_status` x untriaged-signal x turns/elapsed. `evaluateTriageEntry`
//      is a pure function precisely so the page's table can be transcribed into
//      a test rather than reconstructed from query behaviour.
//   2. THE ATTEMPT-ID FENCE and the begin/complete watermark arithmetic, over a
//      fake tenant tx that replays the reads each statement takes. A real
//      two-writer race is not deterministic; what IS deterministic — and what
//      the fence keys on — is the observation sequence, which the fake scripts
//      exactly.
//
// The end-to-end path with real RLS lives in
// packages/db/test/integration/session-triage.int.test.ts.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Scripted pages for the listSessionEvents machinery both statements reuse. */
let eventPages: { items: { id: string }[]; nextCursor?: string; truncated: boolean }[] = []
const listSessionEvents = vi.fn(async () => {
  const page = eventPages.shift()
  if (page === undefined) return { items: [], nextCursor: undefined, truncated: false }
  return { items: page.items, nextCursor: page.nextCursor, truncated: page.truncated }
})
vi.mock('../src/session-events-read.js', () => ({
  listSessionEvents: (...args: unknown[]) => listSessionEvents(...(args as [])),
}))

const {
  AgentSessionTriageConflictError,
  beginSessionTriage,
  completeSessionTriage,
  evaluateTriageEntry,
} = await import('../src/session-triage.js')
const { AgentSessionNotFoundError } = await import('../src/session-lifecycle.js')

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const ATTEMPT = '01890b6e-0000-7000-8000-0000000000bb'
const OTHER_ATTEMPT = '01890b6e-0000-7000-8000-0000000000cc'
const NOW = new Date('2026-08-23T12:00:00.000Z')
const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

const THRESHOLDS = { minTurns: 3, minElapsedMs: 10 * 60_000 }

// ---------------------------------------------------------------------------
// 1. The entry rule + the debounce
// ---------------------------------------------------------------------------

const STATUSES = ['idle', 'pending', 'completed', 'expired', 'overflowed'] as const

/** Defaults chosen so nothing but the axis under test can arm: no signal, no substance. */
function entry(over: Partial<Parameters<typeof evaluateTriageEntry>[0]> = {}) {
  return evaluateTriageEntry({
    live: true,
    triageStatus: 'idle',
    untriagedEvent: false,
    turnCount: 0,
    elapsedMs: 0,
    thresholds: THRESHOLDS,
    ...over,
  })
}

describe('the entry rule (triage_status x signal)', () => {
  it('declines every status on a row that is not leased-open', () => {
    // (b) of the closer-coexistence contract: begin must NEVER arm a closed row.
    // It is checked FIRST, so no status and no amount of signal can get past it.
    for (const triageStatus of STATUSES) {
      expect(entry({ live: false, triageStatus, untriagedEvent: true, turnCount: 99 })).toEqual({
        arm: false,
        reason: 'not-live',
      })
    }
  })

  it('never re-enters an overflowed run — terminal means terminal', () => {
    expect(entry({ triageStatus: 'overflowed', untriagedEvent: true, turnCount: 99 })).toEqual({
      arm: false,
      reason: 'terminal',
    })
  })

  it('declines a pending run so a later Stop finishes it instead of injecting again', () => {
    // The page: a later ordinary Stop that finds `pending` "applies the same
    // complete-or-expire rule and does not inject again".
    expect(entry({ triageStatus: 'pending', untriagedEvent: true, turnCount: 99 })).toEqual({
      arm: false,
      reason: 'pending',
    })
  })

  it('re-enters completed and expired ONLY on an untriaged provenance event', () => {
    for (const triageStatus of ['completed', 'expired'] as const) {
      expect(entry({ triageStatus, untriagedEvent: false, turnCount: 99, elapsedMs: 1e9 })).toEqual(
        { arm: false, reason: 'no-signal' },
      )
      expect(entry({ triageStatus, untriagedEvent: true })).toEqual({ arm: true })
    }
  })

  it('treats an expired run exactly like a completed one for ENTRY (the nag-loop rule)', () => {
    // `expired` is a zero-write continuation. Elapsed time alone must not
    // re-inject on it, or an unresponsive session is nagged every threshold
    // forever — "the numeric cap bounds within-turn continuations, not
    // cross-turn nags". It stays closer-eligible regardless; declining a NUDGE
    // is not declining a debrief.
    const loaded = { turnCount: 1000, elapsedMs: 30 * SESSION_LEASE_MS, untriagedEvent: false }
    expect(entry({ triageStatus: 'expired', ...loaded })).toEqual(
      entry({ triageStatus: 'completed', ...loaded }),
    )
  })

  it('is total: every status x signal pair has a decision', () => {
    for (const triageStatus of STATUSES) {
      for (const untriagedEvent of [false, true]) {
        const decision = entry({ triageStatus, untriagedEvent, turnCount: 99 })
        expect(typeof decision.arm).toBe('boolean')
        if (!decision.arm) expect(decision.reason).toBeTruthy()
      }
    }
  })
})

describe('the debounce (the condition is not optional; the thresholds are)', () => {
  it('does not fire on the first Stop of an idle session', () => {
    // "Arm 'briefed ids non-empty and never triaged' is true at turn 1 of almost
    // every session that has open commitments. Do not fire on first Stop."
    expect(entry({ triageStatus: 'idle', turnCount: 1, elapsedMs: 30_000 })).toEqual({
      arm: false,
      reason: 'debounce',
    })
  })

  it('arms on the turn count alone', () => {
    expect(entry({ turnCount: THRESHOLDS.minTurns })).toEqual({ arm: true })
    expect(entry({ turnCount: THRESHOLDS.minTurns - 1 })).toEqual({
      arm: false,
      reason: 'debounce',
    })
  })

  it('arms on elapsed time alone, for a long low-turn session', () => {
    expect(entry({ elapsedMs: THRESHOLDS.minElapsedMs })).toEqual({ arm: true })
    expect(entry({ elapsedMs: THRESHOLDS.minElapsedMs - 1 })).toEqual({
      arm: false,
      reason: 'debounce',
    })
  })

  it('arms on an untriaged provenance event alone', () => {
    // The third disjunct: "a provenance event that is not itself a prior-triage
    // write" — which is exactly an id outside `last_triaged_event_ids`.
    expect(entry({ untriagedEvent: true, turnCount: 0, elapsedMs: 0 })).toEqual({ arm: true })
  })

  it('treats a missing turn-count hint as zero rather than as satisfied', () => {
    // The hook may omit it; the other two disjuncts still apply. Reading an
    // absent hint as "no opinion, arm anyway" would defeat the debounce for
    // every harness that does not report turns.
    expect(entry({ turnCount: 0, elapsedMs: 0 })).toEqual({ arm: false, reason: 'debounce' })
  })
})

// ---------------------------------------------------------------------------
// 2. The statements: the attempt-id fence and the two watermarks
// ---------------------------------------------------------------------------

const row = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  openedAt: new Date(NOW.getTime() - 60 * 60_000),
  closedAt: null,
  lastSeenAt: NOW,
  triageStatus: 'idle',
  triageAttemptId: null,
  lastTriagedEventIds: [],
  ...over,
})

/**
 * Fake tenant tx replaying one row per SELECT and recording every UPDATE's `set`
 * values and `where` predicate.
 *
 * `updateRows` scripts what each UPDATE ... RETURNING gives back, which is how a
 * test makes the attempt-id predicate REJECT: zero rows returned is exactly what
 * Postgres does when the fence does not match.
 */
function makeTx(
  reads: (Record<string, unknown> | undefined)[],
  updateRows: unknown[][] = [[{ id: RUN }]],
) {
  const updates: { values: Record<string, unknown>; where: unknown }[] = []
  const readQueue = [...reads]
  const updateQueue = [...updateRows]
  const rowLocks: boolean[] = []
  const read = async (rowLocked: boolean) => {
    rowLocks.push(rowLocked)
    const next = readQueue.shift()
    return next === undefined ? [] : [next]
  }
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (strength: string) => read(strength === 'update'),
          limit: () => read(false),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const settle = async () => {
            updates.push({ values, where })
            return updateQueue.shift() ?? []
          }
          return {
            returning: settle,
            // A drizzle update IS a thenable: `begin` awaits it directly while
            // `complete` chains `.returning()`. The fake must be both.
            // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle's thenable update builder
            then: (onOk: (rows: unknown) => unknown, onErr?: (err: unknown) => unknown) =>
              settle().then(onOk, onErr),
          }
        },
      }),
    }),
  }
  return { tx: tx as unknown as Parameters<typeof beginSessionTriage>[0], updates, rowLocks }
}

/** Flatten a drizzle SQL template to its literal text plus bound params. */
function sqlText(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const inner = (chunk as { value?: unknown }).value
      if (Array.isArray(inner)) return inner.map(sqlText).join('')
      if (typeof inner === 'string') return inner
      const name = (chunk as { name?: unknown }).name
      if (typeof name === 'string') return name
      return sqlText(chunk)
    })
    .join('')
}

const begin = (tx: Parameters<typeof beginSessionTriage>[0], turnCount = 99) =>
  beginSessionTriage(tx, USER, KEY, {
    attemptId: ATTEMPT,
    turnCount,
    thresholds: THRESHOLDS,
    now: NOW,
  })

const complete = (tx: Parameters<typeof beginSessionTriage>[0], attemptId = ATTEMPT) =>
  completeSessionTriage(tx, USER, KEY, { attemptId })

/** One page of events, terminal. */
const page = (ids: string[], truncated = false) => ({
  items: ids.map((id) => ({ id })),
  nextCursor: undefined,
  truncated,
})

beforeEach(() => {
  eventPages = []
  listSessionEvents.mockClear()
})

describe('beginSessionTriage', () => {
  it('404s a natural key this tenant owns no row for', async () => {
    // Stop deliberately never CREATES the row: reporting "not armed" for a
    // session that was never opened would hide a broken SessionStart.
    const { tx } = makeTx([undefined])
    await expect(begin(tx)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
  })

  it('reads the row FOR UPDATE before deciding anything', async () => {
    // The decision and the write it justifies must observe the same row version;
    // the row lock is what replaces the epoch fence on this live-row path.
    eventPages = [page([])]
    const { tx, rowLocks } = makeTx([row()])
    await begin(tx)
    expect(rowLocks[0]).toBe(true)
  })

  it('arms: stamps pending, the attempt token and the BEGIN watermark', async () => {
    // The begin stamp is what makes `since_begin` a set difference at complete.
    eventPages = [page(['e1', 'e2'])]
    const { tx, updates } = makeTx([row()])

    await expect(begin(tx)).resolves.toEqual({
      sessionRunId: RUN,
      armed: true,
      attemptId: ATTEMPT,
      triageStatus: 'pending',
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]?.values).toEqual({
      triageStatus: 'pending',
      triageAttemptId: ATTEMPT,
      lastTriagedEventIds: ['e1', 'e2'],
    })
  })

  it('does not list events at all when it declines', async () => {
    // The common Stop. A decline must not pay for a bounded listing of the run.
    const { tx, updates } = makeTx([row({ triageStatus: 'completed' })])

    await expect(begin(tx)).resolves.toMatchObject({ armed: false, reason: 'no-signal' })
    expect(listSessionEvents).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('hands back the in-flight attempt on a pending row, without re-arming', async () => {
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: OTHER_ATTEMPT }),
    ])

    await expect(begin(tx)).resolves.toEqual({
      sessionRunId: RUN,
      armed: false,
      attemptId: OTHER_ATTEMPT,
      triageStatus: 'pending',
      reason: 'pending',
    })
    // Idempotent by construction: no second attempt id is minted and no write
    // happens, so a duplicate Stop delivery cannot double-inject.
    expect(updates).toHaveLength(0)
  })

  it('stamps a run past the per-run ceiling as terminally overflowed', async () => {
    // Declining WITHOUT stamping would re-list the whole ceiling on every later
    // Stop — the signal is present, so the debounce cannot stop it. The terminal
    // stamp is what converges. The partial watermark is NOT written: marking 500
    // never-triaged ids as triaged would be a lie the closer then trusts.
    eventPages = [page(['e1'], true)]
    const { tx, updates } = makeTx([row()])

    await expect(begin(tx)).resolves.toEqual({
      sessionRunId: RUN,
      armed: false,
      triageStatus: 'overflowed',
      reason: 'overflowed',
    })
    expect(updates[0]?.values).toEqual({ triageStatus: 'overflowed' })
  })

  it('walks every page of the run before stamping the begin watermark', async () => {
    eventPages = [{ items: [{ id: 'e1' }], nextCursor: 'e1', truncated: false }, page(['e2', 'e3'])]
    const { tx, updates } = makeTx([row()])

    await begin(tx)

    expect(listSessionEvents).toHaveBeenCalledTimes(2)
    expect(updates[0]?.values.lastTriagedEventIds).toEqual(['e1', 'e2', 'e3'])
  })
})

describe('completeSessionTriage', () => {
  it('completes when the continuation produced provenance, with a CUMULATIVE watermark', async () => {
    // Begin stamped {e1}; the continuation wrote e2. `since_begin` is {e2}, so
    // the outcome is `completed` — but the watermark is {e1, e2}, the full
    // visible set. Storing only the since-begin slice would re-arm immediately
    // on e1, the very event that armed the debounce.
    eventPages = [page(['e1', 'e2'])]
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: ['e1'] }),
    ])

    await expect(complete(tx)).resolves.toEqual({
      sessionRunId: RUN,
      triageStatus: 'completed',
      eventCount: 2,
      sinceBeginCount: 1,
      truncated: false,
    })
    expect(updates[0]?.values).toEqual({
      triageStatus: 'completed',
      lastTriagedEventIds: ['e1', 'e2'],
    })
  })

  it('EXPIRES a zero-write continuation, so the closer still runs', async () => {
    // Nothing new since begin. `expired` is closer-eligible; `completed` would
    // let the run go untriaged forever on the strength of a nudge that failed.
    eventPages = [page(['e1'])]
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: ['e1'] }),
    ])

    await expect(complete(tx)).resolves.toMatchObject({
      triageStatus: 'expired',
      sinceBeginCount: 0,
    })
    // The watermark is still refreshed to the full visible set.
    expect(updates[0]?.values.lastTriagedEventIds).toEqual(['e1'])
  })

  it('detects a since-begin write that carries an EARLIER uuidv7 than the watermark', async () => {
    // The race the page names: "a late-committing write can hold an earlier
    // uuidv7 (assigned at insert, visible after complete)". Set MEMBERSHIP
    // catches it; "ids greater than the last one" would not, and would report a
    // zero-write continuation that in fact wrote.
    eventPages = [page(['e0', 'e5'])]
    const { tx } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: ['e5'] }),
    ])

    await expect(complete(tx)).resolves.toMatchObject({
      triageStatus: 'completed',
      sinceBeginCount: 1,
    })
  })

  it('stamps overflowed when the run passed the ceiling', async () => {
    eventPages = [page(['e1', 'e2'], true)]
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: [] }),
    ])

    await expect(complete(tx)).resolves.toMatchObject({
      triageStatus: 'overflowed',
      truncated: true,
    })
    expect(updates[0]?.values.triageStatus).toBe('overflowed')
  })

  it('rejects a stale attempt id — a crashed hook or a closer that re-claimed', async () => {
    // Boundary case (a): the lease expired mid-handshake, the sweep closed the
    // row, and the closer's CAS replaced the attempt token with its own. The
    // late complete must not clobber the newer attempt's verdict.
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: OTHER_ATTEMPT }),
    ])

    await expect(complete(tx)).rejects.toBeInstanceOf(AgentSessionTriageConflictError)
    expect(updates).toHaveLength(0)
    expect(listSessionEvents).not.toHaveBeenCalled()
  })

  it('rejects a REPEAT complete of the same attempt', async () => {
    // The status leg of the fence. Without it the second call would recompute
    // `since_begin` as empty and demote a `completed` run to `expired`.
    for (const triageStatus of ['completed', 'expired', 'overflowed', 'idle'] as const) {
      const { tx, updates } = makeTx([row({ triageStatus, triageAttemptId: ATTEMPT })])
      await expect(complete(tx)).rejects.toBeInstanceOf(AgentSessionTriageConflictError)
      expect(updates).toHaveLength(0)
    }
  })

  it('re-asserts BOTH fence legs in the UPDATE, not only in the read', async () => {
    // The row lock already makes the in-code check sufficient; the predicate is
    // the durable statement of intent that survives a refactor which drops it.
    eventPages = [page(['e1'])]
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: [] }),
    ])

    await complete(tx)

    const where = sqlText(updates[0]?.where)
    expect(where).toContain('triage_attempt_id')
    expect(where).toContain(ATTEMPT)
    expect(where).toContain('triage_status')
    // (c): the epoch is deliberately NOT part of the handshake predicate — Stop
    // does not carry one, and the row lock already covers the same window.
    expect(where).not.toContain('activation_epoch')
  })

  it('reports a fence lost between the read and the UPDATE as a conflict', async () => {
    // Belt to the row lock's braces: zero rows back from a guarded UPDATE is
    // exactly what Postgres returns when a predicate stops matching.
    eventPages = [page(['e1'])]
    const { tx } = makeTx(
      [row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: [] })],
      [[]],
    )

    await expect(complete(tx)).rejects.toBeInstanceOf(AgentSessionTriageConflictError)
  })

  it('404s a natural key this tenant owns no row for', async () => {
    const { tx } = makeTx([undefined])
    await expect(complete(tx)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
  })

  it('absorbs on a row that closed between begin and complete', async () => {
    // Not guarded on liveness: the attempt id, not the lease, says whether this
    // caller still speaks for the attempt. Refusing would strand the row
    // `pending` for no benefit.
    eventPages = [page(['e1', 'e2'])]
    const { tx } = makeTx([
      row({
        triageStatus: 'pending',
        triageAttemptId: ATTEMPT,
        lastTriagedEventIds: ['e1'],
        closedAt: NOW,
      }),
    ])

    await expect(complete(tx)).resolves.toMatchObject({ triageStatus: 'completed' })
  })

  it('never clears last_message_excerpt — only the closer durably consumes it', async () => {
    eventPages = [page(['e1'])]
    const { tx, updates } = makeTx([
      row({ triageStatus: 'pending', triageAttemptId: ATTEMPT, lastTriagedEventIds: [] }),
    ])

    await complete(tx)

    expect(updates[0]?.values).not.toHaveProperty('lastMessageExcerpt')
    // Nor does it refresh the lease: bookkeeping is not a liveness statement.
    expect(updates[0]?.values).not.toHaveProperty('lastSeenAt')
    expect(updates[0]?.values).not.toHaveProperty('activationEpoch')
  })
})
