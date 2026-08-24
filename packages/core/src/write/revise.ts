// SPDX-License-Identifier: Apache-2.0
// revise(): the synchronous supersede-and-append write path.
//
// apps -> core -> db layering: this is the ONE place the revise JTBD is
// orchestrated. It validates ONCE at the schema boundary (AGENTS.md hard rule
// 2 — packages/db never re-validates) via reviseInputSchema (which EXTENDS
// rememberInputSchema), computes the successor's content hash, and delegates the
// atomic persistence (close predecessor + append successor + typed edge + audit
// event in one withTenant transaction, hard rule 3) to packages/db.
//
// Append-and-supersede (hard rule 1): a revise NEVER mutates the predecessor's
// content — it closes the predecessor's validity and appends a NEW successor row
// linked by a typed edge. The edge intent ('supersedes' | 'updates') is the only
// difference from a fresh remember().
//
// Observability (hard rule 6): never log memory content — ids/hashes/lengths
// only. This module logs nothing; callers that do must honour the same rule.
import { createHash } from 'node:crypto'
import { reviseMemory } from '@3ngram/db'
import { type ActorKind, nativeReviseInputSchema } from '@3ngram/schema'
import { assertWithinBudget } from '../budget/index.js'
import { EMBED_OPERATION, type EmbedOptions, kickEmbed } from './embed.js'
import type { WriteResult } from './remember.js'

export {
  DuplicateMemoryError,
  EdgeConflictError,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  type WrittenMemory,
} from '@3ngram/db'
export type { EmbedOptions } from './embed.js'
export type { WriteResult } from './remember.js'

/**
 * Content hash for the successor — same convention as remember()
 * (sha256 hex of raw content), so seeded, remembered, and revised rows share one
 * hash space and the duplicate guard works across all write paths.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Supersede `predecessorId` with a new memory for `userId`.
 *
 * Single validation boundary: callers pass the RAW payload and `revise`
 * validates it exactly once via nativeReviseInputSchema. Transports must NOT
 * pre-validate — they hand the unparsed request body straight through.
 *
 * @param userId  Tenant whose RLS context the revision runs under.
 * @param input   Raw, UNVALIDATED revise payload — validated here exactly once.
 * @param actorKind  Actor class recorded on the audit events / edge.
 *
 * @throws ZodError if `input` violates the revise contract (validation boundary).
 * @throws PredecessorNotFoundError if the predecessor is absent / not owned.
 * @throws PredecessorAlreadySupersededError if the predecessor is already closed.
 * @throws DuplicateMemoryError if the successor duplicates OTHER live content.
 * @throws EdgeConflictError if the typed edge already exists.
 *
 * Embed-on-write (ack-before-embed): the successor is persisted and the caller
 * ACKed FIRST; only THEN is a background embed of the SUCCESSOR's content kicked
 * via the injected Gateway (`embedOptions.gateway`). The superseded predecessor
 * is never re-embedded. The embed never blocks/fails the revise; its outcome is
 * observable via `embed.settled`. With no gateway, embedding stays NULL.
 *
 * COMMITMENT CARRY (revise -> commitment): the
 * obligation follows the live memory. Revising a commitment-type memory MOVES its
 * commitments FSM row onto the successor (status/due/surfacing survive), so the
 * live successor stays `resolve`-able; revising INTO a commitment from a
 * non-commitment AUTO-CREATES a fresh row (mirrors `remember`). DEMOTING a
 * commitment's type (commitment -> note) RESOLVES a live FSM row in the same tx
 * — an explicit close, never a silent strand on the
 * superseded predecessor. The carry matrix lives in packages/db reviseMemory /
 * carryCommitment.
 */
export async function revise(
  userId: string,
  input: unknown,
  actorKind: ActorKind,
  embedOptions: EmbedOptions = {},
): Promise<WriteResult> {
  const parsed = nativeReviseInputSchema.parse(input)
  // PRE-PERSIST GUARDS (before reviseMemory so a denied revise never lands a
  // successor row): (1) ACCESS — the injected access gate denies a write when the
  // platform policy forbids it (self-host allowAllAccess allows all), throwing
  // AccessDeniedError. Resolved INDEPENDENTLY of the budget so it runs on the
  // embeddings-off path too (access-only options, no budget).
  // (2) BUDGET CAP — throws BudgetExceededError, only when a budget is wired.
  // Access is checked first.
  if (embedOptions.access) await embedOptions.access.assertWrite(userId)
  if (embedOptions.budget) {
    await assertWithinBudget(embedOptions.budget, userId, embedOptions.operation ?? EMBED_OPERATION)
  }
  // ACK FIRST: the supersede+append transaction commits before any embed.
  const written = await reviseMemory({
    userId,
    memoryType: parsed.memoryType,
    topic: parsed.topic,
    content: parsed.content,
    scope: parsed.scope,
    project: parsed.project,
    tags: parsed.tags,
    contentHash: contentHash(parsed.content),
    actorKind,
    predecessorId: parsed.predecessorId,
    edgeType: parsed.edgeIntent,
    sessionRunId: parsed.sessionRunId,
  })
  // THEN embed the SUCCESSOR (best-effort, non-throwing, awaitable).
  const embed = kickEmbed(userId, written.id, parsed.content, actorKind, embedOptions)
  return { ...written, embed }
}
