// SPDX-License-Identifier: Apache-2.0
// remember(): the synchronous memory write path.
//
// apps -> core -> db layering: this is the ONE place the write JTBD is
// orchestrated. It validates ONCE at the schema boundary (AGENTS.md hard rule
// 2 — packages/db never re-validates), computes the content hash, and delegates
// the atomic persistence (memory row + audit event in one withTenant
// transaction, hard rule 3) to packages/db. Transports (REST/MCP) call this;
// they hold zero business logic (hard rule 5).
//
// Append-and-supersede (hard rule 1): a write only ever appends. Re-asserting
// content already live for the tenant is a typed conflict (DuplicateMemoryError
// from packages/db), never a silent duplicate and never an in-place UPDATE.
//
// Observability (hard rule 6): never log memory content — ids/hashes/lengths
// only. This module logs nothing; callers that do must honour the same rule.
import { createHash } from 'node:crypto'
import { type DuplicateMemoryError, type WrittenMemory, writeMemory } from '@3ngram/db'
import { type ActorKind, rememberInputSchema } from '@3ngram/schema'
import { assertWithinBudget, resolveResourceLimits } from '../budget/index.js'
import { EMBED_OPERATION, type EmbedOptions, kickEmbed } from './embed.js'

export { DuplicateMemoryError, type WrittenMemory } from '@3ngram/db'
export type { EmbedOptions } from './embed.js'

/**
 * A completed write plus the AWAITABLE embed handle (ack-before-embed). `id` is
 * the written memory's id (the caller is already ACKed by the time this
 * resolves). `embed.settled` resolves when the background embed task finishes
 * (true = embedding landed); with no injected gateway it resolves false
 * immediately and no embed is attempted. Existing `{ id }` destructuring is
 * unaffected — the handle is additive.
 */
export interface WriteResult extends WrittenMemory {
  embed: { settled: Promise<boolean> }
}

/**
 * Content hash for idempotent backfill detection and the duplicate guard.
 * sha256 hex of the raw content — the exact convention the
 * dev seed uses (packages/db/scripts/seed.mjs), so seeded and live rows share
 * one hash space.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Persist a new memory for `userId`.
 *
 * This is the single validation boundary for the write path (the same
 * convention as createUser): callers pass the RAW payload and `remember`
 * validates it exactly once via rememberInputSchema. Transports must NOT
 * pre-validate — they hand the unparsed request body straight through.
 *
 * @param userId  Tenant whose RLS context the write runs under.
 * @param input   Raw, UNVALIDATED write payload — validated here exactly once.
 * @param actorKind  Actor class recorded on the `create` audit event (which
 *   transport/agent originated the write).
 *
 * Embed-on-write (ack-before-embed): the memory row is persisted and the caller
 * is ACKed FIRST; only THEN is a background embed kicked via the injected
 * Gateway (`embedOptions.gateway`). The embed never blocks or fails the write —
 * its outcome is observable via the returned `embed.settled` handle. With no
 * gateway, no embed is attempted and behaviour is identical to before
 * (embedding stays NULL).
 *
 * @throws ZodError if `input` violates the write contract (validation boundary).
 * @throws {@link DuplicateMemoryError} if active content with the same hash
 *   already exists for the tenant.
 */
export async function remember(
  userId: string,
  input: unknown,
  actorKind: ActorKind,
  embedOptions: EmbedOptions = {},
): Promise<WriteResult> {
  const parsed = rememberInputSchema.parse(input)
  // PRE-PERSIST GUARDS (before writeMemory so a denied write never lands a row):
  //   1. ACCESS: the injected access gate denies a write when the platform policy
  //      forbids it (self-host allowAllAccess allows all). It is resolved
  //      INDEPENDENTLY of the budget so this runs on EVERY write — including the
  //      embeddings-off path, where transports pass an access-only options object
  //      (no budget) — closing the bypass where a denied write could still land a
  //      row. Throws AccessDeniedError → 403/denial.
  //   2. BUDGET CAP: asserted BEFORE writeMemory (the shared seam in
  //      kickEmbed runs only after the row is written), only when a budget is wired
  //      (an embed will incur cost). Throws BudgetExceededError.
  // Access is checked first: a denied user is blocked regardless of budget.
  if (embedOptions.access) await embedOptions.access.assertWrite(userId)
  if (embedOptions.budget) {
    await assertWithinBudget(embedOptions.budget, userId, embedOptions.operation ?? EMBED_OPERATION)
  }
  const { maxLiveMemories } = await resolveResourceLimits(embedOptions.limits, userId)
  // ACK FIRST: the write transaction commits and we hold the id before any
  // embedding round-trip (ack-before-embed).
  const written = await writeMemory(
    {
      userId,
      memoryType: parsed.memoryType,
      topic: parsed.topic,
      content: parsed.content,
      scope: parsed.scope,
      project: parsed.project,
      tags: parsed.tags,
      contentHash: contentHash(parsed.content),
      actorKind,
    },
    maxLiveMemories,
  )
  // THEN kick the (best-effort, non-throwing, awaitable) embed.
  const embed = kickEmbed(userId, written.id, parsed.content, actorKind, embedOptions)
  return { ...written, embed }
}
