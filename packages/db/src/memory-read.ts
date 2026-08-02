// SPDX-License-Identifier: Apache-2.0
// Memory read layer for the dashboard surface. SQL ONLY (hard rule
// 5): defaults, paging policy, and transport shaping live in packages/core
// (read/list-memories.ts, read/memory.ts). TENANT ISOLATION IS TWO-LAYER
// (defense in depth): every query runs inside withTenant(), where RLS scopes
// rows to the caller, AND carries an explicit caller-bound
// `memories.user_id = userId` predicate (the same userId the caller passed into
// withTenant(), facts-read.ts precedent). The predicate is a no-op while RLS
// functions — isolation never rests on a single mechanism.
//
// LIVE-ONLY (the dashboard list JTBD): the list selects only LIVE memories — the
// SAME two-condition liveness scopes.ts / briefing-read.ts use (status = 'active'
// AND valid_to IS NULL). A bare status check overstates the live set: an docs/concepts/memory-model.mdx
// revise leaves the superseded predecessor at status='active' and marks it ONLY
// via valid_to, so without the valid_to gate every revise would inflate the list.
// The single-row inspect (getMemoryById) does NOT apply the live gate — a caller
// inspecting a specific id may legitimately want a superseded row.
//
// Content discipline (hard rule 6): topic/content/tags are content-adjacent and
// are NEVER logged here; callers log ids/lengths only. The list select omits
// content entirely; the detail select returns it because inspect is its JTBD.
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { commitments, memories } from './schema/memory.js'

/** One memory in a list result — identity + orientation columns only (no content). */
export interface MemoryListRow {
  id: string
  memoryType: string
  topic: string
  project: string | null
  scope: string
  status: string
  commitmentStatus?: string | null
  recordedAt: Date
  createdAt: Date
}

/** A full memory row for the single-id inspect read (includes content + tags). */
export interface MemoryDetailRow {
  id: string
  memoryType: string
  topic: string
  content: string
  scope: string
  project: string | null
  status: string
  commitmentStatus?: string | null
  tags: string[]
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
  createdAt: Date
}

/**
 * Filters + paging for {@link listMemories}. Every filter is OPTIONAL and
 * NARROWING. `limit`/`offset` page the bounded list; the caller always supplies a
 * bounded `limit` (no-firehose). `status` narrows the lifecycle axis ON TOP OF the
 * live gate — the list is always live (valid_to IS NULL), so status filters within
 * the active set.
 */
export interface MemoriesListQuery {
  limit: number
  offset: number
  memoryType?: string
  scope?: string
  /** A single project name OR an array for multi-project IN filtering. */
  project?: string | string[]
  status?: string
}

/** The LIVE-memory predicate shared with scopes.ts: status='active' AND valid_to IS NULL. */
const liveMemoryPredicate = (): SQL =>
  and(eq(memories.status, 'active'), isNull(memories.validTo)) as SQL

/**
 * Build the WHERE conditions for a list query: the caller-bound tenant condition
 * (module header) + the live gate + the supplied filters.
 */
function listConditions(userId: string, query: MemoriesListQuery): SQL {
  // The status filter controls which status predicate we apply. All branches keep
  // valid_to IS NULL (current-version gate: an docs/concepts/memory-model.mdx revise marks the superseded
  // predecessor only via valid_to, so without it every revise inflates the list).
  //
  //  • undefined / 'active' → standard live gate: status='active' AND valid_to IS NULL
  //  • 'archived'           → archived current versions: status='archived' AND valid_to IS NULL
  //  • any other value      → drop the status constraint, keep valid_to IS NULL only
  let baseCondition: SQL
  if (query.status === undefined || query.status === 'active') {
    baseCondition = liveMemoryPredicate()
  } else if (query.status === 'archived') {
    baseCondition = and(eq(memories.status, 'archived'), isNull(memories.validTo)) as SQL
  } else {
    baseCondition = isNull(memories.validTo)
  }

  const conditions: SQL[] = [eq(memories.userId, userId), baseCondition]
  if (query.memoryType !== undefined) conditions.push(eq(memories.memoryType, query.memoryType))
  if (query.scope !== undefined) conditions.push(eq(memories.scope, query.scope))
  if (query.project !== undefined) {
    conditions.push(
      Array.isArray(query.project)
        ? inArray(memories.project, query.project)
        : eq(memories.project, query.project),
    )
  }
  return and(...conditions) as SQL
}

/** The unpaged total for a list query (same filters), for the dashboard's pagination. */
export async function countMemories(
  tx: TenantTx,
  userId: string,
  query: MemoriesListQuery,
): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(memories).where(listConditions(userId, query))
  return row?.n ?? 0
}

/**
 * List the tenant's LIVE memories, most-recent first (recorded_at DESC, id as a
 * stable tiebreaker), paged by limit/offset and narrowed by the optional filters.
 * Ordering leads with recorded_at so the dashboard's "Recorded" column renders in
 * true chronological order — including imported memories whose created_at is the
 * import-write time, not the real event date. Identity + orientation
 * columns only — content is never selected (hard rule 6). Empty result is empty,
 * never a throw. Runs inside withTenant(): RLS isolates.
 */
export async function listMemories(
  tx: TenantTx,
  userId: string,
  query: MemoriesListQuery,
): Promise<MemoryListRow[]> {
  return (
    tx
      .select({
        id: memories.id,
        memoryType: memories.memoryType,
        topic: memories.topic,
        project: memories.project,
        scope: memories.scope,
        status: memories.status,
        commitmentStatus: commitments.status,
        recordedAt: memories.recordedAt,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .leftJoin(
        commitments,
        and(eq(commitments.userId, memories.userId), eq(commitments.memoryId, memories.id)),
      )
      .where(listConditions(userId, query))
      // Served by memories_recorded_at_idx (user_id, recorded_at DESC NULLS FIRST,
      // id) — migration 0012,. The index's NULLS FIRST matches ORDER BY DESC's
      // default so the planner reads it in order (Index Scan) instead of Seq Scan +
      // Sort; the id-DESC tiebreak here only re-sorts within equal-timestamp ties
      // (Incremental Sort). briefing-read orders the same way and shares the index.
      .orderBy(desc(memories.recordedAt), desc(memories.id))
      .limit(query.limit)
      .offset(query.offset)
  )
}

/** DISTINCT scope + project values across the tenant's LIVE memories (for dynamic filter UI). */
export interface MemoryFacets {
  scopes: string[]
  projects: string[]
}

/**
 * Return the DISTINCT scope and project values present in the tenant's LIVE
 * memories (status='active' AND valid_to IS NULL). Ordered ASC for a stable
 * surface. Projects exclude NULL (an unscoped memory carries no project).
 * Used by GET /api/v1/memories/facets so the UI can populate filter dropdowns
 * from the actual corpus rather than a hardcoded list.
 */
export async function listMemoryFacets(tx: TenantTx, userId: string): Promise<MemoryFacets> {
  const [scopeRows, projectRows] = await Promise.all([
    tx
      .select({ scope: memories.scope })
      .from(memories)
      .where(and(eq(memories.userId, userId), liveMemoryPredicate()) as SQL)
      .groupBy(memories.scope)
      .orderBy(asc(memories.scope)),
    tx
      .select({ project: memories.project })
      .from(memories)
      .where(
        and(eq(memories.userId, userId), liveMemoryPredicate(), isNotNull(memories.project)) as SQL,
      )
      .groupBy(memories.project)
      .orderBy(asc(memories.project)),
  ])
  return {
    scopes: scopeRows.map((r) => r.scope),
    projects: projectRows.flatMap((r) => (r.project !== null ? [r.project] : [])),
  }
}

/**
 * Fetch one memory by id for the tenant, or undefined when absent. The WHERE
 * keys on (user_id, id): RLS hides cross-tenant rows AND the caller-bound
 * user_id predicate keeps the read caller-only independently of it (module
 * header), so not-found and not-owned collapse to undefined either way. NO live
 * gate: inspecting a specific id may target a superseded row. Returns the full
 * row including content + tags (inspect is its JTBD).
 */
export async function getMemoryById(
  tx: TenantTx,
  userId: string,
  memoryId: string,
): Promise<MemoryDetailRow | undefined> {
  const [row] = await tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      topic: memories.topic,
      content: memories.content,
      scope: memories.scope,
      project: memories.project,
      status: memories.status,
      commitmentStatus: commitments.status,
      tags: memories.tags,
      validFrom: memories.validFrom,
      validTo: memories.validTo,
      recordedAt: memories.recordedAt,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .leftJoin(
      commitments,
      and(eq(commitments.userId, memories.userId), eq(commitments.memoryId, memories.id)),
    )
    .where(and(eq(memories.userId, userId), eq(memories.id, memoryId)))
    .limit(1)
  return row
}
