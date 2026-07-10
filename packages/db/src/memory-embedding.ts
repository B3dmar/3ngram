// SPDX-License-Identifier: Apache-2.0
// Embed-on-write persistence (slice 3, ack-before-embed).
//
// The embedding is DERIVED METADATA, not content (docs/concepts/memory-model.mdx is about CONTENT;
// it is untouched here). After remember()/revise() ACK the caller, a background
// task asks the injected Gateway for an embedding and lands it via this narrow
// helper: a single UPDATE of memories.embedding (+ updated_at, the slice-4
// precedent for derived-metadata writes). The runtime role HAS UPDATE on
// memories (provision-roles.sql), so this works under RLS as app_user.
//
// This is the ONLY place embedding is written. It does NOT touch content,
// topic, tags, or validity — append-and-supersede (hard rule 1) is about
// content, and this writes none. RLS scopes the UPDATE to the tenant; a
// cross-tenant id matches zero rows (returns false), never another tenant's row.
//
// Observability (hard rule 6): the embedding vector and the source text are
// content-derived — never log them. Callers log ids/dimensions only.
import type { ActorKind } from '@3ngram/schema'
import { and, eq, sql } from 'drizzle-orm'
import { withTenant } from './client.js'
import { memories, memoryEvents } from './schema/memory.js'

/** pgvector text literal (`[a,b,c]`) — drizzle has no first-class vector bind. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Persist a computed embedding for `memoryId`, scoped to `userId` (RLS).
 *
 * Returns true if the row was updated, false if no live row matched (the memory
 * was superseded/deleted between ack and embed-settle, or belongs to another
 * tenant). Callers treat false as a benign no-op — there is nothing to embed —
 * and never throw on it. The vector width is the caller's contract
 * (EMBEDDING_DIMENSIONS); a wrong width surfaces as a pg vector_in error, which
 * the background task records as an embed failure rather than propagating.
 *
 * Only `embedding` and `updated_at` change. valid_to is asserted NULL so a
 * superseded predecessor is never re-stamped (its embedding is frozen at close).
 */
export async function updateMemoryEmbedding(
  userId: string,
  memoryId: string,
  embedding: readonly number[],
): Promise<boolean> {
  const vec = toVectorLiteral(embedding)
  return withTenant(userId, async (tx) => {
    const updated = await tx
      .update(memories)
      .set({ embedding: sql`${vec}::vector`, updatedAt: sql`now()` })
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.id, memoryId),
          sql`${memories.validTo} IS NULL`,
        ),
      )
      .returning({ id: memories.id })
    return updated.length > 0
  })
}

/**
 * Record that embedding `memoryId` FAILED — an append-only `embed_failed` event
 * (eventKindSchema, migration 0009). The write itself already succeeded and the
 * caller was ACKed, so this is the durable signal a backfill job keys on; it
 * never throws into the caller. The payload carries a CLASSIFIED, BOUNDED reason
 * label only (error name + optional code + message length, e.g.
 * "Error:429 (msg len 137)" — a backfill-triage aid), NEVER the raw provider
 * message, the source text, or the vector (hard rule 6). The caller
 * (core/write/embed.ts) is responsible for classification; this helper must
 * never be passed free-form provider text.
 */
export async function recordEmbedFailure(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
  reason: string,
): Promise<void> {
  await withTenant(userId, (tx) =>
    tx.insert(memoryEvents).values({
      userId,
      memoryId,
      eventKind: 'embed_failed',
      actorKind,
      payload: { reason },
    }),
  )
}

/** One repair candidate: identity + the content to re-embed (returned to core, never logged). */
export interface EmbedFailedMemoryRow {
  id: string
  content: string
}

/**
 * List LIVE memories whose embedding never landed after an embed failure:
 * `embedding IS NULL`, `valid_to IS NULL`, and at least one `embed_failed`
 * event on record. This is the durable signal recordEmbedFailure leaves —
 * success never appends an event (it sets the column), so a NULL embedding
 * plus an embed_failed event means the LATEST embed attempt failed and the
 * row is repairable (backfill).
 *
 * Bounded by `limit` (caller pages); ordered by id (uuidv7 — stable, roughly
 * chronological). Content is returned because re-embedding IS the caller's
 * JTBD; callers must never log it (hard rule 6).
 */
export async function listEmbedFailedMemories(
  userId: string,
  limit: number,
): Promise<EmbedFailedMemoryRow[]> {
  return withTenant(userId, (tx) =>
    tx
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          sql`${memories.embedding} IS NULL`,
          sql`${memories.validTo} IS NULL`,
          sql`EXISTS (
            SELECT 1 FROM ${memoryEvents}
            WHERE ${memoryEvents.userId} = ${memories.userId}
              AND ${memoryEvents.memoryId} = ${memories.id}
              AND ${memoryEvents.eventKind} = 'embed_failed'
          )`,
        ),
      )
      .orderBy(memories.id)
      .limit(limit),
  )
}
