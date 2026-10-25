// SPDX-License-Identifier: Apache-2.0
// Session closer — step 4, GENERATE (docs/concepts/session-continuity.mdx
// layer 5). Split out of session-closer.ts (hard rule 5's file budget);
// session-closer.ts re-exports the public names.
//
// TWO CLASSIFIERS. Tenants that opted in to judgment (issue #225) are classified
// by `gateway.decide()`, one typed Noul per briefed commitment (issue #229,
// session-closer-judgment.ts); everyone else by the single complete() pass. The
// judgment path FALLS BACK to complete() in exactly two cases, both decided
// before anything reaches the judgment provider:
//   - the deployment has no judgment gateway: decide() rejects with the typed
//     NotImplementedError, caught ONLY around that one await, so a
//     NotImplementedError from anywhere else (after a real call) can never
//     trigger a second, billed pass over the same text;
//   - the tenant opted OUT while this pass waited on its budget reservation:
//     the opt-in is re-read as the last step before the send, after the epoch
//     re-check, because the reservation can block on a per-user lock.
// Each path reserves, re-checks the epoch, calls, records usage and releases on
// its own, so a fallback never bills the judgment operation. The judgment
// ceiling is registered at or below the completion ceiling (pinned by a unit
// test), so a judgment reservation that fits the cap never leaves a fallback
// that does not.
//
// Observability (hard rule 6): ids, counts, operation keys. Never the excerpt,
// the topics or a reply.
import {
  type CompletionResult,
  type DecideResult,
  type Gateway,
  NotImplementedError,
} from '@3ngram/llm'
import {
  type BudgetEnforcement,
  type BudgetReservationHandle,
  releaseBudgetReservation,
  reserveBudgetSlot,
} from '../budget/index.js'
import type { CloserSessionInput, SessionCloserRepo } from './session-closer.js'
import {
  CLOSER_DECIDE_OPERATION,
  renderCloserJudgment,
  selectByJudgment,
} from './session-closer-judgment.js'
import { fenceExcerpt, renderCloserPrompt, selectResolvable } from './session-closer-prompt.js'

/** Gateway operation key for the closer's single generation call. */
export const CLOSER_OPERATION = 'session.closer'

/**
 * Output ceiling for the closer's single call. The reply is a short JSON id
 * list, so this is generous — its job is to stop a looping model turning a
 * bounded classification into an unbounded bill, and to keep the registered
 * `maxCostUsd` the budget gate reserves against honest.
 */
export const CLOSER_MAX_OUTPUT_TOKENS = 1_000

/**
 * Per-token prices for the completion models the closer may run against, USD.
 * Same posture as the embedding price map: a static, reviewed map rather than
 * env-driven, and an UNKNOWN model records `cost_usd = NULL` (tokens still
 * tracked) instead of guessing a number that would silently understate spend.
 */
export const COMPLETION_PRICE_USD_PER_TOKEN: Readonly<
  Record<string, { input: number; output: number }>
> = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
}

/** Cost for one completion, or null when the model is not in the price map. */
export function completionCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const rate = COMPLETION_PRICE_USD_PER_TOKEN[model]
  if (rate === undefined) return null
  return inputTokens * rate.input + outputTokens * rate.output
}

/**
 * Candidates to resolve and mid-band proposals to stage (judgment path only),
 * or `fenced` when the epoch moved before dispatch.
 */
export type CloserVerdict =
  | {
      candidates: string[]
      rejected: number
      proposals: { memoryId: string; probability: number }[]
    }
  | 'fenced'

/** Everything one GENERATE step needs. */
export interface ClassifyCall {
  repo: SessionCloserRepo
  userId: string
  request: { sessionRunId: string; activationEpoch: number }
  gateway: Gateway
  budget: BudgetEnforcement | undefined
  session: CloserSessionInput
  eventKinds: readonly string[]
}

/** The judgment path could not run for this pass; take complete() instead. */
const FALLBACK = Symbol('closer-judgment-fallback')

/**
 * Step 4 for one pass. The first opt-in read is a cheap pre-check so an
 * opted-out tenant never takes a judgment reservation; the authoritative read
 * is the one inside the judgment send.
 */
export async function classify(call: ClassifyCall): Promise<CloserVerdict> {
  if (await call.repo.isJudgmentEnabled(call.userId)) {
    const verdict = await classifyByJudgment(call)
    if (verdict !== FALLBACK) return verdict
  }
  return classifyByCompletion(call)
}

/**
 * Reserve -> epoch re-check -> send -> release, the metered seam both paths
 * share (see step 3b in closeSessionRun's doc for why the re-check sits AFTER
 * the reservation and immediately before dispatch). `send` runs only while the
 * epoch still holds; the reservation is released however it settles.
 */
async function meteredCall<T>(
  call: ClassifyCall,
  operation: string,
  send: () => Promise<T>,
): Promise<T | 'fenced'> {
  let reservation: BudgetReservationHandle | undefined
  try {
    if (call.budget) reservation = await reserveBudgetSlot(call.budget, call.userId, operation)
    const gatewayEpoch = await call.repo.currentEpoch(call.userId, call.request.sessionRunId)
    if (gatewayEpoch !== call.session.activationEpoch) return 'fenced'
    return await send()
  } finally {
    // Release once the call settles; the real cost, if any, is now in llm_usage.
    if (reservation) await releaseBudgetReservation(call.userId, reservation)
  }
}

/** The complete() path: unchanged behaviour for opted-out tenants. */
async function classifyByCompletion(call: ClassifyCall): Promise<CloserVerdict> {
  const { session } = call
  const prompt = renderCloserPrompt({
    briefed: session.briefedMemories,
    eventKinds: call.eventKinds,
    excerpt: session.lastMessageExcerpt,
    project: session.project,
    scope: session.scope,
  })
  const completion = await meteredCall(call, CLOSER_OPERATION, async () => {
    const result: CompletionResult = await call.gateway.complete(prompt, CLOSER_OPERATION, {
      maxOutputTokens: CLOSER_MAX_OUTPUT_TOKENS,
      jsonObject: true,
    })
    // Recorded before anything downstream can throw. Best-effort by contract:
    // a failed accounting write must not lose the resolves. UNPRICED (null
    // cost) when the gateway reported no usage, so the budget gate charges the
    // max registered cost instead of $0.
    const usage = result.usage
    await call.repo
      .recordUsage(call.userId, {
        operation: CLOSER_OPERATION,
        model: result.model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd:
          usage === undefined
            ? null
            : completionCostUsd(result.model, usage.inputTokens, usage.outputTokens),
      })
      .catch(() => undefined)
    return result
  })
  if (completion === 'fenced') return 'fenced'
  return { ...selectResolvable(completion.text, session.briefedMemories), proposals: [] }
}

/**
 * The typed judgment path (issue #229). `rejected` is always 0: the answer id
 * space is the briefed set. High-band answers resolve; mid-band answers become
 * proposals. Usage is recorded UNPRICED — no judgment list price
 * is pinned in this repo — so the budget gate charges the max registered cost.
 */
async function classifyByJudgment(call: ClassifyCall): Promise<CloserVerdict | typeof FALLBACK> {
  const { session } = call
  const judgment = renderCloserJudgment({
    briefed: session.briefedMemories,
    eventKinds: call.eventKinds,
    fencedExcerpt: fenceExcerpt(session.lastMessageExcerpt),
  })
  const decided = await meteredCall(call, CLOSER_DECIDE_OPERATION, async () => {
    // The authoritative opt-in read: the last step before tenant text leaves.
    if (!(await call.repo.isJudgmentEnabled(call.userId))) return FALLBACK
    let result: DecideResult
    try {
      result = await call.gateway.decide(judgment, CLOSER_DECIDE_OPERATION)
    } catch (err) {
      // ONLY a typed "no judgment gateway" falls back; it is raised before I/O.
      if (err instanceof NotImplementedError) return FALLBACK
      throw err
    }
    await call.repo
      .recordUsage(call.userId, {
        operation: CLOSER_DECIDE_OPERATION,
        model: result.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        costUsd: null,
      })
      .catch(() => undefined)
    return result
  })
  if (decided === 'fenced' || decided === FALLBACK) return decided
  const { resolve, propose } = selectByJudgment(decided.answers, session.briefedMemories)
  return { candidates: resolve, rejected: 0, proposals: propose }
}
