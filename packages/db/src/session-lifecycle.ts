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
// LOCK ORDER (repo-wide): advisory BEFORE row. `open` and a RESURRECTING
// heartbeat change the leased-open set, so they take lockSessionAttach() on the
// row's project and only then row-lock. `close` takes no advisory lock at all —
// it must fit the SessionEnd hook budget — which is safe precisely because it
// never waits on one, so it cannot invert the order. Its row lock is what the
// attach path's `SELECT ... FOR UPDATE` queues against (session-provenance.ts).
import type {
  AgentSessionHeartbeatInput,
  AgentSessionNaturalKey,
  AgentSessionOpenInput,
  BriefedMemory,
  BriefingSelectorV2Input,
} from '@3ngram/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { lockSessionAttach, type TenantTx } from './client.js'
import { isUniqueViolation } from './pg-errors.js'
import { agentSessions } from './schema/agent-sessions.js'
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

/** Identity params frozen at open. A `startup` that disagrees with them is a 409, not an overwrite. */
function paramsDiffer(row: AgentSessionRecord, input: AgentSessionOpenInput): boolean {
  return (
    row.project !== (input.project ?? null) ||
    row.scope !== (input.scope ?? null) ||
    JSON.stringify(row.selector) !== JSON.stringify(input.selector)
  )
}

/**
 * Briefing stamp, applied on INSERT only. `resume` must not restamp
 * (the page is explicit), and neither may a duplicate `startup` delivery —
 * `briefed_memories` records what the agent SAW, and a second delivery shows it
 * nothing new. Presence of the key is the delivery signal: an empty array is a
 * briefing that surfaced nothing, which is not the same as no briefing.
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
 * Briefing fields are stamped on INSERT and never restamped. `resume` advances
 * the epoch unconditionally because the page says so: it is an activation, and
 * an extra bump only invalidates a closer claim, which then re-runs — the safe
 * direction for a fence.
 *
 * `resume` on an ABSENT row inserts rather than 404s. The lease is the liveness
 * signal for a session that is demonstrably alive; refusing to record it would
 * make the crash path worse than the one it is protecting.
 *
 * Only `startup` compares params: it is the authoritative open. `resume` may
 * legitimately arrive from a moved cwd with `project` omitted, and the page
 * freezes the row's identity anyway, so comparing there would 409 every resume
 * of a live session instead of refreshing its lease.
 */
export async function openSession(
  tx: TenantTx,
  userId: string,
  input: AgentSessionOpenInput,
  now: Date,
): Promise<OpenSessionResult> {
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
    })
    .where(naturalKeyPredicate(userId, input))
    .returning(RECORD_COLUMNS)
  if (row === undefined) throw new AgentSessionNotFoundError(input)
  return toOpenResult(row, false, reopened)
}

export interface CloseSessionResult {
  row: AgentSessionRecord
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
 * Idempotent by construction: the guarded UPDATE matches open rows only, so a
 * repeat close cannot move the timestamp that window depends on.
 */
export async function closeSession(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  now: Date,
): Promise<CloseSessionResult> {
  const [closed] = await tx
    .update(agentSessions)
    .set({ closedAt: now })
    .where(and(naturalKeyPredicate(userId, key), isNull(agentSessions.closedAt)))
    .returning(RECORD_COLUMNS)
  if (closed !== undefined) return { row: closed, alreadyClosed: false }

  // No open row matched: either already closed (idempotent repeat) or absent.
  const existing = await readByKey(tx, userId, key)
  if (existing === undefined) throw new AgentSessionNotFoundError(key)
  return { row: existing, alreadyClosed: true }
}

export interface HeartbeatSessionResult {
  row: AgentSessionRecord
  /** The refresh revived a closed or lease-expired row (epoch advanced). */
  resurrected: boolean
}

function excerptPatch(input: AgentSessionHeartbeatInput) {
  return input.lastMessageExcerpt === undefined
    ? {}
    : { lastMessageExcerpt: input.lastMessageExcerpt }
}

async function refreshLease(
  tx: TenantTx,
  userId: string,
  input: AgentSessionHeartbeatInput,
  now: Date,
  resurrect: boolean,
): Promise<HeartbeatSessionResult> {
  const [row] = await tx
    .update(agentSessions)
    .set({
      lastSeenAt: monotonicLastSeen(now),
      ...excerptPatch(input),
      ...(resurrect
        ? { closedAt: null, activationEpoch: sql`${agentSessions.activationEpoch} + 1` }
        : {}),
    })
    .where(naturalKeyPredicate(userId, input))
    .returning(RECORD_COLUMNS)
  if (row === undefined) throw new AgentSessionNotFoundError(input)
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
  if (live) return refreshLease(tx, userId, input, now, false)

  await lockSessionAttach(tx, userId, observed.project)
  const fresh = await readByKey(tx, userId, input, { forUpdate: true })
  if (fresh === undefined) throw new AgentSessionNotFoundError(input)
  // A concurrent writer may have resurrected it while we waited for the lock.
  const stillDead = fresh.closedAt !== null || !isLeased(fresh.lastSeenAt, now)
  return refreshLease(tx, userId, input, now, stillDead)
}
