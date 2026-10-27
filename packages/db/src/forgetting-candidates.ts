// SPDX-License-Identifier: Apache-2.0
// Candidate reads for the forgetting pass (docs/concepts/forgetting-pass.mdx,
// "Candidate query"): stale singles, the newer neighbours shown beside each
// single, and conflict pairs.
//
// SQL ONLY (hard rule 5): which types, how stale, how similar, how many, and
// how much content the judge sees are policy in packages/core and arrive as
// arguments. Every query runs in the caller's withTenant() transaction AND
// binds the caller's user_id.
//
// RE-JUDGING: a memory is judged again only after it changes, and never while
// it has an OPEN proposal waiting for review. A retention proposal created
// after a memory's freshness excludes it as a single. A memory named as the
// related side of a proposal (the newer side of a supersede, the other side of
// a conflict) is skipped only while that proposal is open: it was evidence,
// not judged itself. A proposal on either side created after both memories'
// freshness excludes a pair. Freshness is briefing's (`staleFreshness`), so a
// reaffirm counts as a change.
//
// Observability (hard rule 6): these reads return memory content for the
// judge; this module logs nothing.
import { and, asc, type SQL, sql } from 'drizzle-orm'
import { staleCandidatePredicate, staleFreshness } from './briefing-read.js'
import type { TenantTx } from './client.js'
import { memories } from './schema/memory.js'
import { KNN_EF_SEARCH, KNN_OVERFETCH } from './search.js'

/** One live memory as the judge sees it. */
export interface ForgettingMemory {
  id: string
  memoryType: string
  scope: string
  project: string | null
  topic: string
  /** Cut to the caller's `contentChars`. */
  content: string
  recordedAt: Date
  /** Freshness: the later of `updated_at` and `last_reviewed_at`. */
  lastTouchedAt: Date
}

/** A newer live memory of the same type and scope, shown beside a single. */
export interface NewerNeighbour {
  /** The single this neighbour belongs to. */
  forId: string
  id: string
  memoryType: string
  topic: string
  content: string
  recordedAt: Date
  similarity: number
}

/** Two live memories that likely conflict, oriented newer first. */
export interface ConflictPair {
  newer: ForgettingMemory
  older: ForgettingMemory
  similarity: number
  /** The older side is past the stale window; such pairs rank first. */
  olderStale: boolean
}

export interface StaleSinglesOptions {
  staleBefore: Date
  memoryTypes: readonly string[]
  limit: number
  contentChars: number
}

export interface NewerNeighboursOptions {
  perMemory: number
  contentChars: number
}

export interface ConflictPairsOptions {
  /** Minimum cosine similarity. */
  conflictFloor: number
  memoryTypes: readonly string[]
  staleBefore: Date
  limit: number
  contentChars: number
}

/** Serve kNN laterals from the HNSW index with filters, as findSimilarPairs does. */
async function tuneKnn(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
  await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(KNN_EF_SEARCH)}, true)`)
}

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

/**
 * Stale singles: exactly briefing's stale predicate over the whole tenant, minus
 * memories judged since they last changed, most stale first, bounded by `limit`.
 */
export async function staleSingles(
  tx: TenantTx,
  userId: string,
  options: StaleSinglesOptions,
): Promise<ForgettingMemory[]> {
  // Columns inside a raw sql template render qualified ("memories"."id"), so
  // they bind to the outer row; keep `memories` unaliased in this query.
  const judgedSinceTouched = sql`EXISTS (
    SELECT 1 FROM retention_proposals r
    WHERE r.user_id = ${memories.userId}
      AND (r.memory_id = ${memories.id}
           OR (r.related_memory_id = ${memories.id} AND r.status = 'proposed'))
      AND (r.status = 'proposed' OR r.created_at > ${staleFreshness}))`
  return tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      scope: memories.scope,
      project: memories.project,
      topic: memories.topic,
      content: sql<string>`left(${memories.content}, ${options.contentChars}::int)`,
      recordedAt: memories.recordedAt,
      lastTouchedAt: sql<Date>`${staleFreshness}`.mapWith(memories.updatedAt),
    })
    .from(memories)
    .where(
      and(
        staleCandidatePredicate(userId, { kind: 'all' }, options.staleBefore, options.memoryTypes),
        sql`NOT ${judgedSinceTouched}`,
      ),
    )
    .orderBy(asc(staleFreshness), asc(memories.id))
    .limit(options.limit)
}

/**
 * Up to `perMemory` newer live memories per single, of the same type and scope,
 * nearest first. "Newer" is by creation, as consolidation orients pairs. A
 * single without an embedding has no neighbours.
 *
 * With `relaxed_order` the HNSW lateral can return neighbours slightly out of
 * order, so it overfetches `perMemory * KNN_OVERFETCH` and a window keeps the
 * nearest `perMemory`, the findSimilarPairs remedy applied per single.
 */
export async function newerNeighbours(
  tx: TenantTx,
  userId: string,
  memoryIds: readonly string[],
  options: NewerNeighboursOptions,
): Promise<NewerNeighbour[]> {
  if (memoryIds.length === 0) return []
  await tuneKnn(tx)
  const rows = await tx.execute(sql`
    SELECT for_id, id, memory_type, topic, content, recorded_at, similarity
    FROM (
      SELECT a.id AS for_id, b.id, b.memory_type, b.topic,
             left(b.content, ${options.contentChars}::int) AS content,
             b.recorded_at, b.similarity,
             row_number() OVER (PARTITION BY a.id ORDER BY b.similarity DESC, b.id) AS rank
      FROM memories a
      CROSS JOIN LATERAL (
        SELECT b.id, b.memory_type, b.topic, b.content, b.recorded_at,
               GREATEST(0, 1 - (b.embedding <=> a.embedding)) AS similarity
        FROM memories b
        WHERE b.user_id = ${userId}::uuid
          AND b.status = 'active' AND b.valid_to IS NULL AND b.embedding IS NOT NULL
          AND b.memory_type = a.memory_type AND b.scope = a.scope
          AND (b.created_at, b.id) > (a.created_at, a.id)
        ORDER BY b.embedding <=> a.embedding
        LIMIT ${options.perMemory * KNN_OVERFETCH}
      ) AS b
      WHERE a.user_id = ${userId}::uuid
        AND a.id IN (${uuidList(memoryIds)})
        AND a.embedding IS NOT NULL
    ) AS ranked
    WHERE rank <= ${options.perMemory}
    ORDER BY for_id, similarity DESC, id
  `)
  return rows.rows.map((r) => ({
    forId: r.for_id as string,
    id: r.id as string,
    memoryType: r.memory_type as string,
    topic: r.topic as string,
    content: r.content as string,
    recordedAt: new Date(r.recorded_at as string),
    similarity: Number(r.similarity),
  }))
}

/**
 * Conflict pairs: the findSimilarPairs skeleton restricted to two live memories
 * of the same type, scope and project, with the type in `memoryTypes`, at or
 * above `conflictFloor`. A pair is skipped when it already has an edge, a
 * consolidation proposal in any status, or a retention proposal on either side
 * that is still open or was created after both memories last changed. Oriented
 * newer first by creation;
 * pairs whose older side is stale rank first, then by similarity.
 */
export async function conflictPairs(
  tx: TenantTx,
  userId: string,
  options: ConflictPairsOptions,
): Promise<ConflictPair[]> {
  if (options.memoryTypes.length === 0) return []
  await tuneKnn(tx)
  const candidateK = options.limit * KNN_OVERFETCH
  const types = sql.join(
    options.memoryTypes.map((t) => sql`${t}`),
    sql`, `,
  )
  const side = (alias: string) =>
    sql.raw(`${alias}.id AS ${alias}_id, ${alias}.memory_type AS ${alias}_memory_type,
      ${alias}.scope AS ${alias}_scope, ${alias}.project AS ${alias}_project,
      ${alias}.topic AS ${alias}_topic, ${alias}.recorded_at AS ${alias}_recorded_at,
      GREATEST(${alias}.updated_at, ${alias}.last_reviewed_at) AS ${alias}_touched_at`)
  const rows = await tx.execute(sql`
    WITH pairs AS (
      SELECT DISTINCT ON (LEAST(a.id, b.id), GREATEST(a.id, b.id))
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN a.id ELSE b.id END AS newer_id,
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN b.id ELSE a.id END AS older_id,
             GREATEST(0, 1 - (a.embedding <=> b.embedding)) AS similarity,
             (a.embedding <=> b.embedding) AS distance
      FROM memories a
      CROSS JOIN LATERAL (
        SELECT b.id, b.created_at, b.embedding, b.updated_at, b.last_reviewed_at
        FROM memories b
        WHERE b.user_id = ${userId}::uuid
          AND b.status = 'active' AND b.valid_to IS NULL AND b.embedding IS NOT NULL
          AND b.id <> a.id
          AND b.memory_type = a.memory_type
          AND b.scope = a.scope
          AND b.project IS NOT DISTINCT FROM a.project
        ORDER BY b.embedding <=> a.embedding
        LIMIT ${candidateK}
      ) AS b
      WHERE a.user_id = ${userId}::uuid
        AND a.status = 'active' AND a.valid_to IS NULL AND a.embedding IS NOT NULL
        AND a.memory_type IN (${types})
        AND (1 - (a.embedding <=> b.embedding)) >= ${options.conflictFloor}
        AND NOT EXISTS (
          SELECT 1 FROM memory_edges e
          WHERE e.user_id = ${userId}::uuid
            AND LEAST(e.from_id, e.to_id) = LEAST(a.id, b.id)
            AND GREATEST(e.from_id, e.to_id) = GREATEST(a.id, b.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM consolidation_proposals p
          WHERE p.user_id = ${userId}::uuid
            AND LEAST(p.from_id, p.to_id) = LEAST(a.id, b.id)
            AND GREATEST(p.from_id, p.to_id) = GREATEST(a.id, b.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_proposals r
          WHERE r.user_id = ${userId}::uuid
            AND r.memory_id IN (a.id, b.id)
            AND (r.status = 'proposed'
                 OR r.created_at > GREATEST(a.updated_at, a.last_reviewed_at,
                                            b.updated_at, b.last_reviewed_at))
        )
      ORDER BY LEAST(a.id, b.id), GREATEST(a.id, b.id), (a.embedding <=> b.embedding)
    )
    SELECT p.similarity,
           GREATEST(o.updated_at, o.last_reviewed_at) < ${options.staleBefore}::timestamptz AS older_stale,
           ${side('n')}, left(n.content, ${options.contentChars}::int) AS n_content,
           ${side('o')}, left(o.content, ${options.contentChars}::int) AS o_content
    FROM pairs p
    JOIN memories n ON n.user_id = ${userId}::uuid AND n.id = p.newer_id
    JOIN memories o ON o.user_id = ${userId}::uuid AND o.id = p.older_id
    ORDER BY older_stale DESC, p.distance, p.newer_id
    LIMIT ${options.limit}
  `)
  return rows.rows.map((r) => ({
    newer: sideFrom(r, 'n'),
    older: sideFrom(r, 'o'),
    similarity: Number(r.similarity),
    olderStale: r.older_stale === true,
  }))
}

function sideFrom(row: Record<string, unknown>, alias: 'n' | 'o'): ForgettingMemory {
  return {
    id: row[`${alias}_id`] as string,
    memoryType: row[`${alias}_memory_type`] as string,
    scope: row[`${alias}_scope`] as string,
    project: (row[`${alias}_project`] as string | null) ?? null,
    topic: row[`${alias}_topic`] as string,
    content: row[`${alias}_content`] as string,
    recordedAt: new Date(row[`${alias}_recorded_at`] as string),
    lastTouchedAt: new Date(row[`${alias}_touched_at`] as string),
  }
}
