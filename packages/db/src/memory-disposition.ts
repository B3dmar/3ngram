// SPDX-License-Identifier: Apache-2.0
// Disposition persistence for the memory domain (issue #216 umbrella): the
// answers to a stale candidate that append nothing.
//
// ARCHIVE (issue #217) is hard rule 1's audited status carve-out: status moves
// 'active' -> 'archived' on the existing row, recorded by an `archive` memory
// event. Content, topic, tags, valid_from, valid_to and recorded_at are never
// touched, no successor or edge is written, and nothing is deleted, so the
// original content and its provenance stay readable (`status: "archived"`
// filters and `asOf` reads). The transition is the ONLY thing it licenses: it
// is not a path for in-place content or history edits.
//
// valid_to stays NULL (unlike blocker resolve, archiveBlockerMemory): the
// archived bucket every read surface keys on is `status='archived' AND
// valid_to IS NULL` (docs/concepts/data-model.mdx) — setting valid_to would drop
// the row into the superseded bucket instead. The known trade (adoption-gate
// Decision D, kept): the row still holds its live-hash slot in the partial
// unique memories_hash_idx, so re-remembering identical content stays a
// DuplicateMemoryError until the archived row is superseded.
//
// ORDER OF OPERATIONS (moveMemory's template, memory-revise.ts):
//   1. guardSessionMutation — the account-lifecycle lock comes before every
//      other lock, so a disposition never lands after account erasure;
//   2. unlocked peek — a row that will not change returns HERE, before
//      provenance, because attaching a session is a side effect a write that
//      writes nothing must not have;
//   3. resolveSessionProvenance — may take the tenant/project attach advisory
//      lock, so it runs BEFORE any row lock (the canonical order; inverting it
//      deadlocks against reviseMemory);
//   4. FOR UPDATE re-read and re-decide, so a concurrent revise/archive that
//      won in between is reported, not overwritten;
//   5. the UPDATE and its audit event, in the same transaction.
//
// Observability (hard rule 6): nothing here logs; outcomes carry ids only.
import type { ActorKind, ArchiveEventPayload, ReviseDispositionRejection } from '@3ngram/schema'
import { and, eq, sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from './client.js'
import { guardSessionMutation } from './credential-guard.js'
import { commitments, memories, memoryEvents } from './schema/memory.js'
import { resolveSessionProvenance, sessionPayload } from './session-provenance.js'

/** One id's archive outcome. Rejections and repeats write nothing. */
export type ArchiveOutcome =
  | { memoryId: string; outcome: 'archived' | 'already_archived' }
  | { memoryId: string; outcome: 'rejected'; reason: ReviseDispositionRejection }

/**
 * Which guard rails apply. `disposition` (revise archive) rejects blockers and
 * memories riding an open or waiting commitment: both leave the active set
 * through `resolve`, which keeps one path for each. `generic` is the REST
 * archive route's operator contract, unchanged: any active, live row.
 */
export type ArchivePolicy = 'disposition' | 'generic'

export interface ArchiveWrite {
  userId: string
  memoryId: string
  actorKind: ActorKind
  sessionRunId?: string | undefined
  now?: Date | undefined
  policy: ArchivePolicy
}

const archiveState = {
  status: memories.status,
  validTo: memories.validTo,
  memoryType: memories.memoryType,
  project: memories.project,
}
interface ArchiveState {
  status: string
  validTo: Date | null
  memoryType: string
  project: string | null
}
type Verdict =
  | { outcome: 'already_archived' }
  | { outcome: 'rejected'; reason: ReviseDispositionRejection }

/**
 * Decide one row; undefined means "archive it". The commitment read takes a
 * share lock on the locked pass: memory row first, then commitment row — the
 * order reviseMemory's carryCommitment already uses — so a concurrent unresolve
 * cannot reopen the obligation between this check and the UPDATE.
 */
async function judgeArchive(
  tx: TenantTx,
  input: ArchiveWrite,
  row: ArchiveState,
  locked: boolean,
): Promise<Verdict | undefined> {
  if (row.status === 'archived') return { outcome: 'already_archived' }
  if (row.validTo !== null) return { outcome: 'rejected', reason: 'superseded' }
  if (input.policy === 'generic') return undefined
  if (row.memoryType === 'blocker') return { outcome: 'rejected', reason: 'blocker' }
  const query = tx
    .select({ status: commitments.status })
    .from(commitments)
    .where(and(eq(commitments.userId, input.userId), eq(commitments.memoryId, input.memoryId)))
    .limit(1)
  const [commitment] = locked ? await query.for('share') : await query
  if (commitment?.status === 'open' || commitment?.status === 'waiting') {
    return { outcome: 'rejected', reason: 'open_commitment' }
  }
  return undefined
}

/**
 * Archive one memory inside the caller's withTenant transaction (see the module
 * header for the order of operations). Never throws for a row that cannot be
 * archived: unknown and other-tenant ids (RLS hides them) are `not_found`, a
 * repeat is `already_archived`, and the policy's rejections carry a reason.
 *
 * @throws AccountDeletedError the account is being erased.
 * @throws UnknownSessionRunError a supplied run id is not this tenant's.
 */
export async function archiveMemoryIn(tx: TenantTx, input: ArchiveWrite): Promise<ArchiveOutcome> {
  const { userId, memoryId } = input
  await guardSessionMutation(tx, userId)
  const target = and(eq(memories.userId, userId), eq(memories.id, memoryId))

  const [peek] = await tx.select(archiveState).from(memories).where(target).limit(1)
  if (!peek) return { memoryId, outcome: 'rejected', reason: 'not_found' }
  const early = await judgeArchive(tx, input, peek, false)
  if (early) return { memoryId, ...early }

  const runId = await resolveSessionProvenance(tx, userId, {
    sessionRunId: input.sessionRunId,
    project: peek.project,
    now: input.now ?? new Date(),
  })

  const [current] = await tx
    .select(archiveState)
    .from(memories)
    .where(target)
    .limit(1)
    .for('update')
  if (!current) return { memoryId, outcome: 'rejected', reason: 'not_found' }
  const late = await judgeArchive(tx, input, current, true)
  if (late) return { memoryId, ...late }

  await tx.update(memories).set({ status: 'archived', updatedAt: sql`now()` }).where(target)
  await tx.insert(memoryEvents).values({
    userId,
    memoryId,
    eventKind: 'archive',
    actorKind: input.actorKind,
    // Built under the schema's inferred type, not parsed: validation happens
    // once, at the boundary (hard rule 2).
    payload: {
      ...(sessionPayload(runId) ?? {}),
      disposition: 'archive',
    } satisfies ArchiveEventPayload,
  })
  return { memoryId, outcome: 'archived' }
}

/**
 * The revise archive disposition for ONE id, in its own transaction: a batch
 * reports per-id outcomes, so one id's rejection or lost race never rolls back
 * another id's archive.
 */
export function archiveMemoryDisposition(
  input: Omit<ArchiveWrite, 'policy'>,
): Promise<ArchiveOutcome> {
  return withTenant(input.userId, (tx) => archiveMemoryIn(tx, { ...input, policy: 'disposition' }))
}

/**
 * Thrown when no ACTIVE memory exists for this tenant under the given id (the
 * REST archive route). Under RLS a cross-tenant id returns zero rows, so "not
 * found", "not owned", "already archived", and "superseded" all collapse to this
 * one error — each is, from the tenant's view, "there is no active memory by
 * this id to archive". Carries the id (a uuid, never content).
 */
export class ActiveMemoryNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('no active memory found for this tenant')
    this.name = 'ActiveMemoryNotFoundError'
    this.memoryId = memoryId
  }
}

/**
 * The REST archive route's write: archive an ACTIVE memory of ANY type (the
 * `generic` policy), audited like every archive disposition. Anything other
 * than a fresh archive is the route's typed miss, as it always was.
 *
 * @throws {@link ActiveMemoryNotFoundError} no active memory by this id for the tenant.
 */
export async function archiveMemory(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
  sessionRunId?: string,
  now?: Date,
): Promise<{ id: string; status: 'archived' }> {
  const result = await withTenant(userId, (tx) =>
    archiveMemoryIn(tx, { userId, memoryId, actorKind, sessionRunId, now, policy: 'generic' }),
  )
  if (result.outcome !== 'archived') throw new ActiveMemoryNotFoundError(memoryId)
  return { id: memoryId, status: 'archived' }
}
