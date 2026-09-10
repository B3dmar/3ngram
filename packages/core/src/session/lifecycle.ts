// SPDX-License-Identifier: Apache-2.0
// Agent-session bookkeeping: open / close / heartbeat, plus the row read the
// debrief render needs (docs/concepts/session-continuity.mdx layers 1, 4, 6).
//
// A PASS-THROUGH by design. The lease arithmetic, the epoch fence, the advisory
// and row locking and the idempotency rules all live in packages/db; core adds
// exactly two things: the single parse at the validation boundary (hard rule 2 —
// the transports hand raw input straight here) and the withTenant() wrapper that
// puts RLS around the statements.
//
// These are BOOKKEEPING writes, not memory writes: they touch `agent_sessions`
// only, emit no `memory_events`, and can never reach the corpus. That is why
// they sit beside the memory write facade rather than inside it.

import {
  AgentSessionNotFoundError,
  type AgentSessionRecord,
  type AgentSessionRunRead,
  type CloseSessionResult,
  closeSession as closeSessionDb,
  type HeartbeatSessionResult,
  heartbeatSession as heartbeatSessionDb,
  type OpenSessionResult,
  openSession as openSessionDb,
  readAgentSession as readAgentSessionDb,
  readAgentSessionRun as readAgentSessionRunDb,
  UnknownSessionRunError,
  withTenant,
} from '@3ngram/db'
import {
  type AgentSessionHeartbeatInput,
  type AgentSessionNaturalKey,
  type AgentSessionOpenBodyInput,
  agentSessionCloseBodySchema,
  agentSessionHeartbeatBodySchema,
  agentSessionNaturalKeySchema,
  agentSessionOpenBodySchema,
  type TriageAttemptLogEntry,
} from '@3ngram/schema'

export type {
  AgentSessionRecord,
  AgentSessionRunRead,
  CloseSessionResult,
  HeartbeatSessionResult,
  OpenSessionResult,
} from '@3ngram/db'
// AccountDeletedError rides along: `openSession` refuses an erased account
// rather than writing a session row after erasure (packages/db/account-delete.ts
// — erasure is the FINAL content write), so a transport mapping this facade's
// failures has to name it.
export {
  AccountDeletedError,
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
} from '@3ngram/db'

/** Injected clock — the worker and tests pass a fixed instant; a transport passes none. */
export interface SessionClockOptions {
  now?: Date | undefined
}

function clock(options: SessionClockOptions | undefined): Date {
  return options?.now ?? new Date()
}

/**
 * SessionStart. `startup` inserts and stamps the briefing rows the hook says
 * survived its local truncate; `resume` reuses the row, advances
 * `activation_epoch`, reopens a closed or lease-expired row and refreshes the
 * lease — without restamping the briefing.
 *
 * Idempotent by the natural key, which doubles as the request token: a repeat
 * `startup` with the same identity params is a duplicate hook delivery and
 * changes nothing, while one with DIFFERENT params raises
 * `AgentSessionParamsConflictError` rather than silently overwriting the row
 * a live session is leasing.
 */
export async function openAgentSession(
  userId: string,
  // The z.INPUT type: `selector` is optional here because the schema defaults
  // it. Taking z.infer would make every TypeScript caller hand-write
  // `{ kind: 'all' }` — the exact default this boundary exists to apply — and a
  // transport that forwards a raw body would not type-check at all.
  input: AgentSessionOpenBodyInput,
  options?: SessionClockOptions,
): Promise<OpenSessionResult> {
  const parsed = agentSessionOpenBodySchema.parse(input)
  const now = clock(options)
  return withTenant(userId, (tx) => openSessionDb(tx, userId, parsed, now))
}

/**
 * SessionEnd. Natural key only — no `activation_epoch`, because SessionEnd does
 * not have one and must not persist a local activation token to get one. A
 * stale close is transient: the next heartbeat or resume resurrects the row and
 * bumps the epoch, so the closer's fence ignores work claimed under the old one.
 * Idempotent: a repeat close reports the FIRST close's timestamp.
 */
export async function closeAgentSession(
  userId: string,
  input: AgentSessionNaturalKey,
  options?: SessionClockOptions,
): Promise<CloseSessionResult> {
  const parsed = agentSessionCloseBodySchema.parse(input)
  const now = clock(options)
  return withTenant(userId, (tx) => closeSessionDb(tx, userId, parsed, now))
}

/**
 * Stop. Refreshes the lease monotonically, resurrecting a closed or
 * lease-expired row, and snapshots the turn's bounded `last_assistant_message`
 * when the hook carries one — SessionEnd has no final-message field, so this is
 * the only path that fills the closer's excerpt in the common case.
 */
export async function heartbeatAgentSession(
  userId: string,
  input: AgentSessionHeartbeatInput,
  options?: SessionClockOptions,
): Promise<HeartbeatSessionResult> {
  const parsed = agentSessionHeartbeatBodySchema.parse(input)
  const now = clock(options)
  return withTenant(userId, (tx) => heartbeatSessionDb(tx, userId, parsed, now))
}

/**
 * The bookkeeping row for one run. Read-only: the debrief render inlines
 * `briefed_memories` as an id -> topic/status mapping, and rendering must not
 * refresh a lease as a side effect of being read.
 *
 * Absence is an ERROR, not an empty result — the same shape `listSessionEvents`
 * gives an unowned run id. A caller that named a natural key wants THAT run's
 * briefed rows; quietly rendering without them would hand the model "resolve
 * what you completed" with no ids, which is the failure the mapping exists to
 * fix. RLS makes not-owned and not-found one answer.
 */
export async function getAgentSession(
  userId: string,
  input: AgentSessionNaturalKey,
): Promise<AgentSessionRecord> {
  const parsed = agentSessionNaturalKeySchema.parse(input)
  const row = await withTenant(userId, (tx) => readAgentSessionDb(tx, userId, parsed))
  if (row === undefined) throw new AgentSessionNotFoundError(parsed)
  return row
}

/**
 * The bookkeeping row for one run, addressed by `sessionRunId` (issue #203).
 * Read-only like {@link getAgentSession}: a validation-phase audit read must
 * never refresh a lease — or resurrect a closed row — by being taken.
 *
 * An unknown or foreign id FAILS with {@link UnknownSessionRunError}, exactly
 * as `listSessionEvents` does for the same path parameter: RLS makes not-owned
 * and not-found one answer, and the read matches the write path's contract
 * rather than inventing an empty result. The transport parses the path id
 * through `sessionRunIdSchema` (canonicalizing the spelling) before calling —
 * same division as the events route.
 */
export async function getAgentSessionRun(
  userId: string,
  sessionRunId: string,
): Promise<AgentSessionRunRead> {
  const row = await withTenant(userId, (tx) => readAgentSessionRunDb(tx, userId, sessionRunId))
  if (row === undefined) throw new UnknownSessionRunError(sessionRunId)
  return row
}

/** One run's interactive nudge history, as the triage-attempts read serves it. */
export interface SessionTriageAttempts {
  sessionRunId: string
  /** Oldest first; the newest MAX_TRIAGE_ATTEMPT_LOG entries the row kept. */
  items: TriageAttemptLogEntry[]
  /** The true attempt total the row knows of (see the schema's doc). */
  count: number
  /** `count > items.length` — a cap trim, or a legacy seed with no entry. */
  truncated: boolean
}

/**
 * The run's interactive nudge history (issue #203). The `truncated`
 * derivation — "the list is not the whole denominator" — is the domain
 * invariant relating the bounded log to the count column, so it lives HERE
 * rather than in a transport (hard rule 5): every consumer gets the same
 * answer, and a route is left with serialization only.
 */
export async function getSessionTriageAttempts(
  userId: string,
  sessionRunId: string,
): Promise<SessionTriageAttempts> {
  const row = await getAgentSessionRun(userId, sessionRunId)
  return {
    sessionRunId: row.id,
    items: row.triageAttemptLog,
    count: row.triageAttemptCount,
    truncated: row.triageAttemptCount > row.triageAttemptLog.length,
  }
}
