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
  type CloseSessionResult,
  closeSession as closeSessionDb,
  type HeartbeatSessionResult,
  heartbeatSession as heartbeatSessionDb,
  type OpenSessionResult,
  openSession as openSessionDb,
  readAgentSession as readAgentSessionDb,
  withTenant,
} from '@3ngram/db'
import {
  type AgentSessionHeartbeatInput,
  type AgentSessionNaturalKey,
  type AgentSessionOpenInput,
  agentSessionCloseBodySchema,
  agentSessionHeartbeatBodySchema,
  agentSessionNaturalKeySchema,
  agentSessionOpenBodySchema,
} from '@3ngram/schema'

export type {
  AgentSessionRecord,
  CloseSessionResult,
  HeartbeatSessionResult,
  OpenSessionResult,
} from '@3ngram/db'
export { AgentSessionNotFoundError, AgentSessionParamsConflictError } from '@3ngram/db'

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
  input: AgentSessionOpenInput,
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
