// SPDX-License-Identifier: Apache-2.0
// Forgetting pass (docs/concepts/forgetting-pass.mdx): one run for one tenant.
// It reads the candidates, judges them in batches through `gateway.decide()`
// and stages each batch's verdicts as retention proposals. Proposals only: it
// never archives, supersedes or edits a memory.
//
// GATES, each decided before tenant text leaves the process:
//   - the tenant opted in to judgment. A cheap pre-check skips the whole run;
//     the authoritative read sits immediately before every send, after the
//     budget reservation, which can block on a per-user lock;
//   - the deployment has a judgment gateway. decide() rejects with the typed
//     NotImplementedError before any I/O, and the pass stops. There is no
//     complete() fallback;
//   - the budget. Each batch reserves the operation's ceiling first, and the
//     pass stops at the first refusal instead of billing past the cap.
// Each batch is staged as soon as it returns, so a later stop keeps the work
// already done, and the candidate reads skip what was staged. A crash between
// a batch returning and its staging loses that one batch: a retry judges and
// bills it again. Nothing is staged twice.
//
// Observability (hard rule 6): ids, counts and operation keys only.
import {
  type ConflictPair,
  conflictPairs,
  type ForgettingMemory,
  insertLlmUsage,
  insertRetentionProposals,
  type NewerNeighbour,
  newerNeighbours,
  type RetentionVerdictWrite,
  staleSingles,
  withTenant,
} from '@3ngram/db'
import { type DecideResult, type Gateway, NotImplementedError } from '@3ngram/llm'
import {
  type BudgetEnforcement,
  BudgetExceededError,
  type BudgetReservationHandle,
  releaseBudgetReservation,
  reserveBudgetSlot,
} from '../budget/index.js'
import { STALE_CANDIDATE_TYPES, STALE_WINDOW_DAYS } from '../read/briefing.js'
import { isJudgmentEnabled } from '../settings/judgment.js'
import {
  batchItems,
  buildItems,
  FORGET_DECIDE_OPERATION,
  FORGETTING_CONFLICT_FLOOR,
  FORGETTING_NEWER_NEIGHBOURS,
  FORGETTING_PAIR_TYPES,
  FORGETTING_PAIRS_CAP,
  FORGETTING_SINGLES_CAP,
  type ForgettingBatch,
  JUDGED_CONTENT_CHARS,
  NEIGHBOUR_CONTENT_CHARS,
  verdictsFromAnswers,
} from './forgetting-judgment.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The candidates one run judges. */
export interface ForgettingCandidates {
  singles: readonly ForgettingMemory[]
  pairs: readonly ConflictPair[]
  neighbours: readonly NewerNeighbour[]
}

/** One judgment call's accounting. Recorded unpriced: no judgment list price is pinned. */
export interface ForgettingUsage {
  operation: string
  model: string
  inputTokens: number
  outputTokens: number
}

/** The pass's reads and writes, injected so the pass is testable without a database. */
export interface ForgettingRepo {
  isJudgmentEnabled(userId: string): Promise<boolean>
  readCandidates(userId: string, now: Date): Promise<ForgettingCandidates>
  /** Stage verdicts; returns the rows inserted. */
  stage(userId: string, verdicts: readonly RetentionVerdictWrite[]): Promise<number>
  recordUsage(userId: string, usage: ForgettingUsage): Promise<void>
}

/** Why a run stopped before judging every batch. */
export type ForgettingStop = 'not-opted-in' | 'opted-out' | 'no-gateway' | 'budget'

/** Counts only: what one run judged and staged. */
export interface ForgettingPassResult {
  /** Present when the run stopped early. */
  stopped?: ForgettingStop
  /** Items built from the candidates. */
  items: number
  /** decide() calls that returned. */
  batches: number
  /** Verdicts that wait for review. */
  proposed: number
  /** Keep verdicts and verdicts below their threshold. */
  dismissed: number
  /** Items whose answer yielded no verdict. */
  skipped: number
  /** Rows inserted; fewer than proposed + dismissed when a memory changed meanwhile. */
  staged: number
}

export interface ForgettingPassOptions {
  gateway: Gateway
  repo?: ForgettingRepo | undefined
  budget?: BudgetEnforcement | undefined
  now?: Date | undefined
}

/** Run the forgetting pass for one tenant. */
export async function runForgettingPass(
  userId: string,
  options: ForgettingPassOptions,
): Promise<ForgettingPassResult> {
  const repo = options.repo ?? dbForgettingRepo
  const now = options.now ?? new Date()
  const result: ForgettingPassResult = {
    items: 0,
    batches: 0,
    proposed: 0,
    dismissed: 0,
    skipped: 0,
    staged: 0,
  }
  if (!(await repo.isJudgmentEnabled(userId))) return { ...result, stopped: 'not-opted-in' }
  const items = buildItems(await repo.readCandidates(userId, now))
  result.items = items.length
  for (const batch of batchItems(items, now)) {
    const decided = await judgeBatch(userId, batch, options, repo)
    if (typeof decided === 'string') return { ...result, stopped: decided }
    result.batches += 1
    const { verdicts, skipped } = verdictsFromAnswers(batch.items, decided.answers, decided.model)
    result.skipped += skipped
    for (const verdict of verdicts) {
      if (verdict.action === 'keep' || verdict.dismissed === true) result.dismissed += 1
      else result.proposed += 1
    }
    if (verdicts.length > 0) result.staged += await repo.stage(userId, verdicts)
  }
  return result
}

/**
 * Reserve, re-check the opt-in, send, record usage, release. Returns the
 * answers, or why the run must stop. Any other gateway error propagates; the
 * batches staged so far stay staged.
 */
async function judgeBatch(
  userId: string,
  batch: ForgettingBatch,
  options: ForgettingPassOptions,
  repo: ForgettingRepo,
): Promise<DecideResult | ForgettingStop> {
  let reservation: BudgetReservationHandle | undefined
  try {
    if (options.budget) {
      try {
        reservation = await reserveBudgetSlot(options.budget, userId, FORGET_DECIDE_OPERATION)
      } catch (error) {
        if (error instanceof BudgetExceededError) return 'budget'
        throw error
      }
    }
    // The authoritative opt-in read: the last step before tenant text leaves.
    if (!(await repo.isJudgmentEnabled(userId))) return 'opted-out'
    let decided: DecideResult
    try {
      decided = await options.gateway.decide(batch.request, FORGET_DECIDE_OPERATION)
    } catch (error) {
      // ONLY the typed "no judgment gateway" stops quietly; it is raised before I/O.
      if (error instanceof NotImplementedError) return 'no-gateway'
      throw error
    }
    // Best-effort by contract: a failed accounting write must not lose the verdicts.
    await repo
      .recordUsage(userId, {
        operation: FORGET_DECIDE_OPERATION,
        model: decided.model,
        inputTokens: decided.usage?.inputTokens ?? 0,
        outputTokens: decided.usage?.outputTokens ?? 0,
      })
      .catch(() => undefined)
    return decided
  } finally {
    if (reservation) await releaseBudgetReservation(userId, reservation)
  }
}

/** The production repo: each member opens its own tenant transaction. */
export const dbForgettingRepo: ForgettingRepo = {
  isJudgmentEnabled: (userId) => isJudgmentEnabled(userId),
  readCandidates: (userId, now) => {
    const staleBefore = new Date(now.getTime() - STALE_WINDOW_DAYS * MS_PER_DAY)
    return withTenant(userId, async (tx) => {
      const singles = await staleSingles(tx, userId, {
        staleBefore,
        memoryTypes: STALE_CANDIDATE_TYPES,
        limit: FORGETTING_SINGLES_CAP,
        contentChars: JUDGED_CONTENT_CHARS,
      })
      const pairs = await conflictPairs(tx, userId, {
        conflictFloor: FORGETTING_CONFLICT_FLOOR,
        memoryTypes: FORGETTING_PAIR_TYPES,
        staleBefore,
        limit: FORGETTING_PAIRS_CAP,
        contentChars: JUDGED_CONTENT_CHARS,
      })
      const neighbours = await newerNeighbours(
        tx,
        userId,
        singles.map((s) => s.id),
        { perMemory: FORGETTING_NEWER_NEIGHBOURS, contentChars: NEIGHBOUR_CONTENT_CHARS },
      )
      return { singles, pairs, neighbours }
    })
  },
  stage: (userId, verdicts) =>
    withTenant(userId, (tx) => insertRetentionProposals(tx, userId, verdicts)),
  recordUsage: (userId, usage) => insertLlmUsage(userId, { ...usage, costUsd: null }),
}
