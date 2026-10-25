// SPDX-License-Identifier: Apache-2.0
// reviseDisposition(): the `revise` dispositions that append nothing (issue
// #216 umbrella) — `archive` (issue #217) and `reaffirm` (issue #218).
//
// apps -> core -> db layering (hard rule 5): validates ONCE at the schema
// boundary (nativeReviseDispositionInputSchema, hard rule 2) and walks the id
// batch, delegating each id to packages/db, which runs it in its own
// withTenant transaction (hard rule 3).
//
// PER-ID OUTCOMES, ONE TRANSACTION PER ID (not one atomic batch): every row's
// disposition is independent — no invariant spans two ids — so a stale-review
// batch where one id was concurrently superseded must not roll back the
// others. Ids run sequentially, holding one pool connection at a time. An
// infrastructure failure mid-batch throws with the earlier ids committed;
// a retry is safe because a repeated archive reports `already_archived` and
// writes nothing, and a repeated reaffirm only records one more review.
//
// A supplied sessionRunId is checked ONCE, up front: the contract is that an
// unowned run id fails the whole write, even when every id would have been a
// rejection that writes nothing.
//
// Observability (hard rule 6): logs nothing; outcomes carry ids only.
import {
  archiveMemoryDisposition,
  assertSessionRunOwned,
  reaffirmMemoryDisposition,
} from '@3ngram/db'
import {
  type ActorKind,
  nativeReviseDispositionInputSchema,
  type ReviseDispositionOutput,
} from '@3ngram/schema'
import type { AccessGate } from '../budget/index.js'

/** Options a disposition honours: the write access gate only (nothing is embedded). */
export interface ReviseDispositionOptions {
  access?: AccessGate | undefined
  /** Injected clock for session provenance (tests). */
  now?: Date | undefined
}

/**
 * Apply a `revise` disposition to each listed memory for `userId`.
 *
 * @param input  Raw, UNVALIDATED disposition payload — validated here exactly once.
 * @returns the kind and one outcome per requested id, in request order.
 * @throws ZodError the payload violates the disposition contract.
 * @throws AccessDeniedError the access gate denies the write.
 * @throws UnknownSessionRunError a supplied run id is not this tenant's.
 */
export async function reviseDisposition(
  userId: string,
  input: unknown,
  actorKind: ActorKind,
  options: ReviseDispositionOptions = {},
): Promise<ReviseDispositionOutput> {
  const parsed = nativeReviseDispositionInputSchema.parse(input)
  if (options.access) await options.access.assertWrite(userId)
  if (parsed.sessionRunId !== undefined) await assertSessionRunOwned(userId, parsed.sessionRunId)

  const dispose = parsed.kind === 'archive' ? archiveMemoryDisposition : reaffirmMemoryDisposition
  const outcomes: ReviseDispositionOutput['outcomes'] = []
  for (const memoryId of parsed.memoryIds) {
    const result = await dispose({
      userId,
      memoryId,
      actorKind,
      sessionRunId: parsed.sessionRunId,
      now: options.now,
    })
    outcomes.push(result)
  }
  return { kind: parsed.kind, outcomes }
}
