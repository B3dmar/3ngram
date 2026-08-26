// SPDX-License-Identifier: Apache-2.0
// Hook-facing agent-session bookkeeping: open / close / heartbeat + the row read
// the REST debrief render needs (docs/concepts/session-continuity.mdx layers 1,
// 4 and 6).
//
// SQL ONLY — core validates at the schema boundary and wraps these in
// withTenant(), so RLS scopes every statement to the caller. Every function is
// addressed by the NATURAL KEY (user_id, agent, session_id): Stop and SessionEnd
// are separate processes holding the harness conversation id and nothing else,
// and the page forbids a local run-id mapping file.
//
// LOCK ORDER (repo-wide): account-lifecycle BEFORE session-attach BEFORE row.
// `open` and a RESURRECTING heartbeat change the leased-open set, so they take
// lockSessionAttach() on the row's project and only then row-lock. The two paths
// that write user CONTENT take the account-lifecycle lock in SHARED mode ahead of
// both: `open` (which inserts the selector and briefing rows, or restamps them on
// reopen) and a heartbeat carrying an excerpt. `close` takes no advisory lock at
// all — it must fit the SessionEnd hook budget — which is safe precisely because
// it never waits on one, so it cannot invert the order. Its row lock is what the
// attach path's `SELECT ... FOR UPDATE` queues against (session-provenance.ts).
import type {
  AgentSessionHeartbeatInput,
  AgentSessionNaturalKey,
  AgentSessionOpenInput,
  BriefedMemory,
  BriefingSelectorV2Input,
} from '@3ngram/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { deletedEmail } from './account-delete.js'
import { lockAccountLifecycleShared, lockSessionAttach, type TenantTx } from './client.js'
import { guardSessionMutation } from './credential-guard.js'
import { isUniqueViolation } from './pg-errors.js'
import { agentSessions } from './schema/agent-sessions.js'
import { users } from './schema/identity.js'
import { isLeased, monotonicLastSeen } from './session-lease.js'

/** No row for this tenant's `(agent, session_id)`. Never a cross-tenant probe: RLS hides those identically. */
export class AgentSessionNotFoundError extends Error {
  readonly agent: string
  readonly sessionId: string
  constructor(key: AgentSessionNaturalKey) {
    super('no agent session for this natural key')
    this.name = 'AgentSessionNotFoundError'
    this.agent = key.agent
    this.sessionId = key.sessionId
  }
}

/**
 * A `startup` open reused a natural key that already names a row opened with
 * DIFFERENT identity params — the "request token; reuse with changed params is
 * 409" rule from the page's REST surface table. The natural key IS the request
 * token here: it is what a duplicate hook delivery repeats, and what a harness
 * that recycled a conversation id would collide on.
 */
export class AgentSessionParamsConflictError extends Error {
  readonly agent: string
  readonly sessionId: string
  constructor(key: AgentSessionNaturalKey) {
    super('agent session already opened with different parameters')
    this.name = 'AgentSessionParamsConflictError'
    this.agent = key.agent
    this.sessionId = key.sessionId
  }
}

/** The bookkeeping row, as the lifecycle paths need it. No memory content rides here. */
export interface AgentSessionRecord {
  id: string
  agent: string
  sessionId: string
  source: string
  project: string | null
  scope: string | null
  selector: BriefingSelectorV2Input
  activationEpoch: number
  openedAt: Date
  closedAt: Date | null
  lastSeenAt: Date
  briefingDeliveredAt: Date | null
  briefedMemories: BriefedMemory[]
}

const RECORD_COLUMNS = {
  id: agentSessions.id,
  agent: agentSessions.agent,
  sessionId: agentSessions.sessionId,
  source: agentSessions.source,
  project: agentSessions.project,
  scope: agentSessions.scope,
  selector: agentSessions.selector,
  activationEpoch: agentSessions.activationEpoch,
  openedAt: agentSessions.openedAt,
  closedAt: agentSessions.closedAt,
  lastSeenAt: agentSessions.lastSeenAt,
  briefingDeliveredAt: agentSessions.briefingDeliveredAt,
  briefedMemories: agentSessions.briefedMemories,
} as const

function naturalKeyPredicate(userId: string, key: AgentSessionNaturalKey) {
  return and(
    eq(agentSessions.userId, userId),
    eq(agentSessions.agent, key.agent),
    eq(agentSessions.sessionId, key.sessionId),
  )
}

/**
 * Read one row by natural key. `forUpdate` row-locks it for the rest of the
 * transaction and is only ever used AFTER {@link lockSessionAttach} (advisory ->
 * row). See session-provenance.ts for why the decision and the write it
 * justifies must observe the same row version.
 */
async function readByKey(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  opts?: { forUpdate?: boolean },
): Promise<AgentSessionRecord | undefined> {
  const query = tx
    .select(RECORD_COLUMNS)
    .from(agentSessions)
    .where(naturalKeyPredicate(userId, key))
  const [row] = opts?.forUpdate === true ? await query.for('update') : await query
  return row
}

/**
 * The bookkeeping row for one run, or undefined. Read-only: the REST debrief
 * render needs `briefed_memories` to inline the id -> topic/status mapping, and
 * rendering a prompt must never refresh a lease as a side effect.
 */
export async function readAgentSession(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
): Promise<AgentSessionRecord | undefined> {
  return readByKey(tx, userId, key)
}

/**
 * Key-order-independent JSON for comparing a stored `jsonb` selector against an
 * inbound one. Postgres `jsonb` does NOT preserve key order — it stores keys
 * sorted by length then bytewise — so the driver can hand back
 * `{"kind":"scope","scope":"work"}` for a value written as
 * `{"scope":"work","kind":"scope"}`. A raw `JSON.stringify` comparison would
 * read that round-trip as a parameter CHANGE and 409 a perfectly ordinary
 * duplicate `startup` delivery.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Identity params frozen at open. A `startup` that disagrees with them is a 409, not an overwrite. */
function paramsDiffer(row: AgentSessionRecord, input: AgentSessionOpenInput): boolean {
  return (
    row.project !== (input.project ?? null) ||
    row.scope !== (input.scope ?? null) ||
    canonicalJson(row.selector) !== canonicalJson(input.selector)
  )
}

/**
 * Briefing stamp. Applied on INSERT, and again on a `startup` that REOPENS a
 * closed or lease-expired row — every startup renders a briefing and truncates
 * it locally, so every startup must record what survived the cut, or
 * `briefed_memories` describes a delivery from a previous activation.
 *
 * Never applied to `resume` (the page is explicit), and never to a duplicate
 * `startup` delivery onto a still-live row: that second delivery showed the
 * agent nothing new. Presence of the key is the delivery signal — an empty
 * array is a briefing that surfaced nothing, which is not the same as no
 * briefing.
 */
function briefingStamp(input: AgentSessionOpenInput, now: Date) {
  if (input.briefedMemories === undefined) return {}
  return { briefedMemories: input.briefedMemories, briefingDeliveredAt: now }
}

function toOpenResult(row: AgentSessionRecord, created: boolean, reopened: boolean) {
  return { row, created, reopened }
}

export interface OpenSessionResult {
  row: AgentSessionRecord
  /** This call inserted the row. */
  created: boolean
  /** This call revived a closed or lease-expired row (epoch advanced). */
  reopened: boolean
}

/**
 * Insert the row for a natural key nothing owned yet.
 *
 * The attach lock keyed on the request's project serializes the ordinary case,
 * but two opens of the SAME natural key carrying DIFFERENT projects hold
 * DIFFERENT keys, so both can reach this INSERT and the loser hits
 * `agent_sessions_natural_key`. That is exactly the collision
 * {@link AgentSessionParamsConflictError} names — one conversation id being
 * opened as two different sessions — so it is reported as the same `409` rather
 * than escaping as an unmapped driver error. Widening the lock to cover it
 * would mean locking every project key, which the attach path cannot do.
 */
async function insertSession(
  tx: TenantTx,
  userId: string,
  input: AgentSessionOpenInput,
  now: Date,
): Promise<OpenSessionResult> {
  const inserted = await tx
    .insert(agentSessions)
    .values({
      userId,
      agent: input.agent,
      sessionId: input.sessionId,
      source: input.source,
      project: input.project ?? null,
      scope: input.scope ?? null,
      selector: input.selector,
      openedAt: now,
      lastSeenAt: now,
      ...briefingStamp(input, now),
    })
    .returning(RECORD_COLUMNS)
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new AgentSessionParamsConflictError(input)
      throw error
    })
  const row = inserted[0]
  if (row === undefined) throw new AgentSessionNotFoundError(input)
  return toOpenResult(row, true, false)
}

/**
 * SessionStart. Idempotent by natural key, per the page's `source` table:
 *
 * | source  | absent            | leased-open row              | closed or stale row      |
 * |---------|-------------------|------------------------------|--------------------------|
 * | startup | INSERT, epoch 1   | no-op + heartbeat (retry)    | reopen, epoch + 1        |
 * | resume  | INSERT, epoch 1   | epoch + 1, heartbeat         | reopen, epoch + 1        |
 *
 * Briefing fields are stamped on INSERT and on a `startup` that REOPENS (see
 * {@link briefingStamp}); a duplicate `startup` onto a live row and every
 * `resume` leave them alone. `resume` advances the epoch unconditionally because
 * the page says so: it is an activation, and an extra bump only invalidates a
 * closer claim, which then re-runs — the safe direction for a fence.
 *
 * `resume` on an ABSENT row inserts rather than 404s. The lease is the liveness
 * signal for a session that is demonstrably alive; refusing to record it would
 * make the crash path worse than the one it is protecting.
 *
 * Only `startup` compares params: it is the authoritative open. `resume` may
 * legitimately arrive from a moved cwd with `project` omitted, and the page
 * freezes the row's identity anyway, so comparing there would 409 every resume
 * of a live session instead of refreshing its lease.
 *
 * REFUSES an erased account. Both branches below write user content — the INSERT
 * carries the selector and the briefing rows, and a reopening `startup` restamps
 * them — so an `/open` still in flight when erasure commits would land content
 * after the redaction that must be the FINAL content write (account-delete.ts).
 * {@link guardSessionMutation} is therefore the FIRST statement, before the
 * unlocked probe and the attach lock, per the file's lock order.
 */
export async function openSession(
  tx: TenantTx,
  userId: string,
  input: AgentSessionOpenInput,
  now: Date,
): Promise<OpenSessionResult> {
  await guardSessionMutation(tx, userId)
  // Probe unlocked to learn the row's CURRENT project: the advisory key is the
  // row's project, not the request's, so an attacher counting leased-open rows
  // for that project is serialized against this INSERT/resurrect. Held to commit
  // — zero/one/many is only valid at commit (session-provenance.ts).
  const observed = await readByKey(tx, userId, input)
  await lockSessionAttach(tx, userId, observed?.project ?? input.project ?? null)
  const existing = await readByKey(tx, userId, input, { forUpdate: true })
  if (existing === undefined) return insertSession(tx, userId, input, now)
  if (input.source === 'startup' && paramsDiffer(existing, input)) {
    throw new AgentSessionParamsConflictError(input)
  }

  const reopened = existing.closedAt !== null || !isLeased(existing.lastSeenAt, now)
  const bumpEpoch = reopened || input.source === 'resume'
  const [row] = await tx
    .update(agentSessions)
    .set({
      lastSeenAt: monotonicLastSeen(now),
      ...(reopened ? { closedAt: null } : {}),
      ...(bumpEpoch ? { activationEpoch: sql`${agentSessions.activationEpoch} + 1` } : {}),
      // A reopening startup is a NEW activation that just rendered and locally
      // truncated a fresh briefing, so it restamps what survived. A startup onto
      // a still-live row is a duplicate delivery and restamps nothing.
      ...(reopened && input.source === 'startup' ? briefingStamp(input, now) : {}),
      // GENUINELY RE-ARMED BY NEW WORK (issue #184): the primary SessionStart
      // resume path. A stale backoff from the PREVIOUS activation must not gate
      // the row this activation eventually closes — see the same reset in
      // session-provenance.ts `resurrect` for the full argument.
      ...(reopened ? { closerFailureCount: 0, closerNextAttemptAt: null } : {}),
    })
    .where(naturalKeyPredicate(userId, input))
    .returning(RECORD_COLUMNS)
  if (row === undefined) throw new AgentSessionNotFoundError(input)
  return toOpenResult(row, false, reopened)
}

export interface CloseSessionResult {
  row: AgentSessionRecord
  /**
   * When this call stamped it, `now`; otherwise the timestamp the FIRST close
   * stamped. Non-null by construction, unlike `row.closedAt`, so no caller has
   * to invent one for a column it cannot prove is set.
   */
  closedAt: Date
  /** The row already carried a `closed_at`; this call changed nothing. */
  alreadyClosed: boolean
}

/**
 * SessionEnd. Natural key only — SessionEnd has no `activation_epoch` and must
 * not need one, and a stale close is transient because the next heartbeat or
 * resume resurrects.
 *
 * Deliberately does NOT touch `last_seen_at`: an explicit close freezes it, so
 * `closed_at <= last_seen_at + lease` keeps identifying this as a SessionEnd
 * rather than a sweeper's implicit close, forever. It also does not clear
 * `last_message_excerpt` — only the closer, once it has durably consumed it.
 *
 * READ THE ROW UNDER A LOCK, then write. An earlier shape ran a guarded
 * `WHERE closed_at IS NULL` UPDATE and, on zero rows, re-read to decide between
 * "already closed" and "absent". That re-read is a second snapshot: a row
 * INSERTed by a concurrent `open` in the gap is live with `closed_at` null, and
 * the fallback would report `alreadyClosed: true` for a session nothing ever
 * closed. `FOR UPDATE` collapses the two observations into one, so the decision
 * and the write see the same row version and the answer is never invented.
 *
 * Still no advisory lock — close must fit the SessionEnd hook budget, and a
 * path that never acquires one cannot invert advisory-before-row.
 */
export async function closeSession(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  now: Date,
): Promise<CloseSessionResult> {
  const existing = await readByKey(tx, userId, key, { forUpdate: true })
  if (existing === undefined) throw new AgentSessionNotFoundError(key)
  // Idempotent: never restamp. Re-stamping would move the row past the
  // `closed_at <= last_seen_at + lease` window that tells an explicit SessionEnd
  // apart from a sweeper's implicit close, forever.
  if (existing.closedAt !== null) {
    return { row: existing, closedAt: existing.closedAt, alreadyClosed: true }
  }
  const [closed] = await tx
    .update(agentSessions)
    .set({ closedAt: now })
    .where(naturalKeyPredicate(userId, key))
    .returning(RECORD_COLUMNS)
  if (closed === undefined) throw new AgentSessionNotFoundError(key)
  return { row: closed, closedAt: closed.closedAt ?? now, alreadyClosed: false }
}

export interface HeartbeatSessionResult {
  row: AgentSessionRecord
  /** The refresh revived a closed or lease-expired row (epoch advanced). */
  resurrected: boolean
}

/**
 * The excerpt patch, or `{}` when writing it would land user CONTENT on an
 * erased account.
 *
 * `last_message_excerpt` is the only user content this module writes, and
 * account erasure must be the FINAL content write (account-delete.ts). Without
 * this guard an in-flight heartbeat that blocks on the row erasure is updating
 * resumes after erasure commits — credentials already revoked — and writes the
 * agent's message back onto the tombstoned account.
 *
 * The SHARED account-lifecycle lock is what makes the check trustworthy. A
 * tombstone test alone is not: under READ COMMITTED an UPDATE that waits on a
 * concurrently-updated row re-evaluates its qual against the new row version but
 * evaluates subqueries over OTHER relations (here `users`) with the ORIGINAL
 * snapshot, so an `EXISTS (... users ...)` guard would still pass. Holding the
 * lock in shared mode means no erasure can be mid-flight or commit while we
 * decide and write, and the fresh statement below sees any erasure that
 * committed before we acquired it. Heartbeats do not conflict with each other,
 * so the hot path stays parallel; only erasure waits.
 *
 * LOCK ORDER: account-lifecycle BEFORE the session-attach advisory lock and
 * before any row lock. Erasure takes account-lifecycle and never takes
 * session-attach, so the two orders share a prefix and cannot cycle. Acquiring
 * here is therefore either the transaction's first lock (the fast heartbeat
 * path) or a re-acquisition of one {@link heartbeatSession} already hoisted
 * above its attach lock for exactly this reason.
 *
 * DROPS the excerpt rather than throwing, unlike {@link openSession}, which
 * refuses outright: the rest of a heartbeat is structural skeleton erasure
 * preserves, so the lease refresh still means something on a tombstoned account,
 * whereas an open exists only to write the row it is refused.
 */
async function excerptPatch(
  tx: TenantTx,
  userId: string,
  input: AgentSessionHeartbeatInput,
): Promise<{ lastMessageExcerpt?: string }> {
  if (input.lastMessageExcerpt === undefined) return {}
  await lockAccountLifecycleShared(tx, userId)
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  // No row, or a tombstoned one: drop the excerpt and keep the rest of the
  // heartbeat. The lease is structural skeleton that erasure never touches, so
  // refreshing it writes nothing that was erased. The epoch is NOT untouched
  // any more (issue #185): erasure now bumps it in the same statement as the
  // redaction (account-delete.ts), specifically so an in-flight closer pass
  // fences off the content this function is about to drop. A heartbeat that
  // still reaches this point is running on a credential that erasure has
  // already revoked in the same tx — an ordinary post-revocation race, not one this
  // shared lock closes — and if it goes on to resurrect a closed row below, it
  // only bumps the epoch further, never back to a value a closer could have
  // claimed at.
  if (user === undefined || user.email === deletedEmail(userId)) return {}
  return { lastMessageExcerpt: input.lastMessageExcerpt }
}

/**
 * Write the lease refresh.
 *
 * `onlyOpen` guards the UPDATE with `closed_at IS NULL` and returns undefined
 * when nothing matched, which is how the caller learns that a close committed
 * between its unlocked probe and this statement.
 */
async function refreshLease(
  tx: TenantTx,
  userId: string,
  input: AgentSessionHeartbeatInput,
  now: Date,
  resurrect: boolean,
  onlyOpen = false,
): Promise<HeartbeatSessionResult | undefined> {
  const excerpt = await excerptPatch(tx, userId, input)
  const [row] = await tx
    .update(agentSessions)
    .set({
      lastSeenAt: monotonicLastSeen(now),
      ...excerpt,
      ...(resurrect
        ? {
            closedAt: null,
            activationEpoch: sql`${agentSessions.activationEpoch} + 1`,
            // Same reset, same reason (issue #184): Stop's own resurrect branch.
            closerFailureCount: 0,
            closerNextAttemptAt: null,
          }
        : {}),
    })
    .where(
      onlyOpen
        ? and(naturalKeyPredicate(userId, input), isNull(agentSessions.closedAt))
        : naturalKeyPredicate(userId, input),
    )
    .returning(RECORD_COLUMNS)
  if (row === undefined) {
    if (onlyOpen) return undefined
    throw new AgentSessionNotFoundError(input)
  }
  return { row, resurrected: resurrect }
}

/**
 * Stop. Refreshes the lease monotonically and, when the hook carries one,
 * snapshots the turn's bounded `last_assistant_message` — SessionEnd has no
 * final-message field, so without this the closer sees null in the common case.
 *
 * RESURRECTS a closed or lease-expired row, per the page: implicit close is not
 * SessionEnd, and "a delayed stale close is transient — the next heartbeat or
 * resume resurrects and bumps the epoch". That is the one place heartbeat and
 * the WRITE attach path differ: a write onto an explicitly closed row stays
 * unattributed, because a write is not a statement that the session is alive.
 *
 * The resurrect decision is made under the attach lock and a re-read that ROW
 * locks, exactly like attachKnownRun: two heartbeats that both saw the row stale
 * must advance `activation_epoch` ONCE for one resurrection, or a closer fenced
 * at the first epoch is invalidated for nothing. The fast path stays unlocked so
 * a live session's per-turn heartbeat never queues behind a row lock.
 *
 * That unlocked probe is why the fast path's UPDATE is GUARDED on
 * `closed_at IS NULL`. A `/close` committing in the gap would otherwise leave a
 * fast heartbeat stamping `last_seen_at` and the excerpt onto a row whose
 * `closed_at` stays set, returning `resurrected: false` — an active conversation
 * silently left closed and closer-eligible, with nothing to reopen it until the
 * next lease expiry. Zero rows means the probe was stale, so the call falls
 * through to the locking path, which re-reads FOR UPDATE and resurrects.
 */
export async function heartbeatSession(
  tx: TenantTx,
  userId: string,
  input: AgentSessionHeartbeatInput,
  now: Date,
): Promise<HeartbeatSessionResult> {
  const observed = await readByKey(tx, userId, input)
  if (observed === undefined) throw new AgentSessionNotFoundError(input)
  const live = observed.closedAt === null && isLeased(observed.lastSeenAt, now)
  if (live) {
    const fast = await refreshLease(tx, userId, input, now, false, true)
    if (fast !== undefined) return fast
    // A close committed between the probe and the UPDATE. Fall through.
  }

  // LOCK ORDER, and the reason this is hoisted rather than left to
  // {@link excerptPatch}: that guard runs BELOW the attach lock, so a heartbeat
  // carrying an excerpt would request account-lifecycle while holding
  // session-attach — the opposite order from {@link openSession}, which now
  // holds account-lifecycle SHARED while it waits for session-attach. With an
  // erasure queued exclusively in between, Postgres makes a new shared request
  // wait behind that waiter, and the two orders close a cycle. Taking it here
  // keeps every account-lifecycle holder ahead of every attach holder. Only when
  // the hook actually carries content: an excerpt-free heartbeat writes nothing
  // erasure touches and must not pay for the lock.
  if (input.lastMessageExcerpt !== undefined) await lockAccountLifecycleShared(tx, userId)
  await lockSessionAttach(tx, userId, observed.project)
  const fresh = await readByKey(tx, userId, input, { forUpdate: true })
  if (fresh === undefined) throw new AgentSessionNotFoundError(input)
  // A concurrent writer may have resurrected it while we waited for the lock.
  const stillDead = fresh.closedAt !== null || !isLeased(fresh.lastSeenAt, now)
  const beat = await refreshLease(tx, userId, input, now, stillDead)
  // Unguarded (onlyOpen === false), so refreshLease throws rather than
  // returning undefined; the assertion is here to keep the type total.
  if (beat === undefined) throw new AgentSessionNotFoundError(input)
  return beat
}
