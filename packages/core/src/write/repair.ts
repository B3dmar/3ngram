// SPDX-License-Identifier: Apache-2.0
// embed_failed repair path.
//
// A migration rehearsal landed 7 of 14,233 memories as `embed_failed`
// (transient gateway HTTP failures during the batch backfill's per-item retry
// storm); their embeddings stayed NULL, making them invisible to the vector
// search leg. This module is the durable repair: find every LIVE memory whose
// latest embed attempt failed (NULL embedding + an embed_failed event on
// record) and re-run the embed through the SAME kickEmbed task — success lands
// the vector via the narrow db helper, refailure appends another classified
// embed_failed event. Append-only either way (hard rule 1: no events are
// rewritten, no content is touched — the vector is derived metadata, docs/concepts/memory-model.mdx).
//
// Deliberately minimal: a single exported function, callable from a worker
// job, a CLI, or the migration tool at cutover. Rows are processed
// sequentially — repair batches are small (single digits observed) and the
// sequential loop cannot trip provider rate limits the way a parallel storm
// can (the original failure mode).
//
// Observability (hard rule 6): content flows from the db helper into the
// gateway and is NEVER logged here — the result carries counts only.
import { listEmbedFailedMemories } from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { type EmbedOptions, kickEmbed } from './embed.js'

/** Page bound for one repair pass — callers loop passes if scanned === limit. */
const DEFAULT_REPAIR_LIMIT = 500

/** Options for {@link retryFailedEmbeds}: the injected embed surface + paging. */
export interface RetryFailedEmbedsOptions extends EmbedOptions {
  /** Max rows repaired in one pass. Defaults to {@link DEFAULT_REPAIR_LIMIT}. */
  limit?: number | undefined
  /** Actor recorded on refailure events. Defaults to 'system'. */
  actorKind?: ActorKind | undefined
}

/** Counts only — never ids-with-content, never the inputs (hard rule 6). */
export interface RetryFailedEmbedsResult {
  /** Candidate rows found (NULL embedding + embed_failed event, live). */
  scanned: number
  /** Embeddings that landed on this pass. */
  landed: number
  /** Rows that did not land: a fresh embed_failed event was appended, or the
   * row was superseded mid-pass (benign no-op, same as the write path). */
  failed: number
}

/**
 * Re-run the embed for every repairable memory (latest embed attempt failed,
 * embedding still NULL, row still live). Each row goes through kickEmbed —
 * the SAME guarded task the write path uses, so empty inputs are deterministic
 * `empty_input` refailures without a gateway call, and provider errors are
 * classified into bounded labels. Never throws per-row; a gateway-less call is
 * a misuse and throws up front (repair without a gateway can only refail).
 */
export async function retryFailedEmbeds(
  userId: string,
  options: RetryFailedEmbedsOptions,
): Promise<RetryFailedEmbedsResult> {
  if (!options.gateway) throw new Error('retryFailedEmbeds requires an injected gateway')
  const limit = options.limit ?? DEFAULT_REPAIR_LIMIT
  const actorKind = options.actorKind ?? 'system'
  const rows = await listEmbedFailedMemories(userId, limit)
  const result: RetryFailedEmbedsResult = { scanned: rows.length, landed: 0, failed: 0 }
  for (const row of rows) {
    const landed = await kickEmbed(userId, row.id, row.content, actorKind, options).settled
    if (landed) result.landed += 1
    else result.failed += 1
  }
  return result
}
