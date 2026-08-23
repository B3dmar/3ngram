// SPDX-License-Identifier: Apache-2.0
// The Stop-nudge handshake facade (docs/concepts/session-continuity.mdx layer 4;
// issue #166 step 7a).
//
// A PASS-THROUGH by design, like the rest of this module. The entry rule, the
// debounce arithmetic, the begin/complete watermarks and the attempt-id fence
// all live in packages/db; core adds the single parse at the validation boundary
// (hard rule 2 — the transport hands the raw body straight here), the
// withTenant() wrapper that puts RLS around the statements, and the two INJECTED
// dependencies a pure db function must not invent for itself: the clock and the
// attempt-id minter.
//
// THRESHOLDS ARE INJECTED, NOT READ. `@3ngram/core` deliberately does not depend
// on `@3ngram/config` (see packages/core/package.json), so the composition root
// resolves `loadSessionTriageConfig()` and passes it down. That keeps ONE owner
// for the default values — the env schema — instead of a core-side copy free to
// drift from it.
import {
  AgentSessionTriageConflictError,
  type BeginTriageResult,
  beginSessionTriage as beginSessionTriageDb,
  type CompleteTriageResult,
  completeSessionTriage as completeSessionTriageDb,
  type TriageDebounceThresholds,
  withTenant,
} from '@3ngram/db'
import {
  type AgentSessionTriageBeginInput,
  type AgentSessionTriageCompleteInput,
  agentSessionTriageBeginBodySchema,
  agentSessionTriageCompleteBodySchema,
} from '@3ngram/schema'
import type { SessionClockOptions } from './lifecycle.js'

export type {
  BeginTriageOptions,
  BeginTriageResult,
  CompleteTriageResult,
  TriageDebounceThresholds,
  TriageEntryDecision,
} from '@3ngram/db'
export { AgentSessionTriageConflictError, evaluateTriageEntry } from '@3ngram/db'

/** Everything `begin` needs beyond the tenant and the body. */
export interface BeginTriageFacadeOptions extends SessionClockOptions {
  /** Tunable debounce floors, resolved from config at the composition root. */
  thresholds: TriageDebounceThresholds
  /**
   * Mints the attempt token. Injected so a test can pin it, exactly as the
   * closer's `newAttemptId` is. Defaults to `crypto.randomUUID()`.
   */
  newAttemptId?: (() => string) | undefined
}

/**
 * Stop, first half. Evaluates ELIGIBILITY and the DEBOUNCE server-side and
 * answers `armed`; the hook injects the debrief only when armed.
 *
 * The decision lives here rather than in the hook so every harness applies the
 * same rule — the same reason 3ngram owns the debrief words and the hook owns
 * only the trigger. A hook that guessed would drift per harness and per version.
 *
 * A natural key this tenant owns no row for is an ERROR (404), never a silent
 * "not armed": Stop must never create a missing row, and reporting "no nudge"
 * for a session that was never opened would hide a broken SessionStart behind a
 * perfectly ordinary-looking decline.
 */
export async function beginAgentSessionTriage(
  userId: string,
  input: AgentSessionTriageBeginInput,
  options: BeginTriageFacadeOptions,
): Promise<BeginTriageResult> {
  const parsed = agentSessionTriageBeginBodySchema.parse(input)
  const now = options.now ?? new Date()
  const attemptId = options.newAttemptId?.() ?? crypto.randomUUID()
  return withTenant(userId, (tx) =>
    beginSessionTriageDb(
      tx,
      userId,
      { agent: parsed.agent, sessionId: parsed.sessionId },
      {
        attemptId,
        ...(parsed.turnCount === undefined ? {} : { turnCount: parsed.turnCount }),
        thresholds: options.thresholds,
        now,
      },
    ),
  )
}

/**
 * Stop, second half. Absorbs whatever the continuation wrote and stamps the
 * outcome: `completed` when the continuation produced provenance, `expired` when
 * it produced none (so the closer still runs), `overflowed` past the per-run
 * ceiling. The watermark it stamps is the CUMULATIVE visible set, not the
 * since-begin slice.
 *
 * Throws {@link AgentSessionTriageConflictError} when the attempt named is no
 * longer the current one — a crashed hook retrying, a second Stop, or a closer
 * that re-claimed the row after the lease expired mid-handshake.
 */
export async function completeAgentSessionTriage(
  userId: string,
  input: AgentSessionTriageCompleteInput,
): Promise<CompleteTriageResult> {
  const parsed = agentSessionTriageCompleteBodySchema.parse(input)
  return withTenant(userId, (tx) =>
    completeSessionTriageDb(
      tx,
      userId,
      { agent: parsed.agent, sessionId: parsed.sessionId },
      { attemptId: parsed.attemptId },
    ),
  )
}
