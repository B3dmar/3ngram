// SPDX-License-Identifier: Apache-2.0
// Scopes registry + environment-stats read layer (docs/concepts/mcp-design.mdx: configure_scope, describe_environment).
//
// This module owns the SQL ONLY (hard rule 5: business policy — defaults,
// param shaping, the read-vs-write scope split — lives in packages/core). Every
// query runs inside withTenant(): RLS scopes every row to the caller, AND every
// query here ALSO carries an explicit caller-bound predicate (user_id = the
// withTenant userId). Two layers, tenant-isolation hardening: RLS is the primary
// boundary; the in-query predicate is defense in depth so a mutation can never
// match another owner's row even if RLS were inert. (user_id, name) is the
// natural key — the scopes_name_idx unique index — so the predicate is a no-op
// when RLS is active: it matches exactly the caller's rows.
//
// SCOPES REGISTRY vs memories.scope TEXT (the D3 design tension). The scopes
// table is a NAME/ALIAS REGISTRY: a user-defined set of scope names plus their
// aliases. memories.scope is a DENORMALIZED TEXT column (default 'personal'),
// NOT a foreign key to this table — a memory may carry ANY scope name, registered
// or not ('personal' itself ships unregistered). Consequence for DELETE: removing
// a scope row is purely a registry edit; it NEVER touches memory rows, so a
// memory whose scope text matches a deleted scope keeps that text intact and
// stays fully valid. There is no orphaning and no cascade — by design (docs/concepts/memory-model.mdx
// append-and-supersede protects MEMORY data; the registry is not memory data).
// The runtime role therefore holds a real DELETE grant on `scopes` ONLY
// (provision-roles.sql) — every memory-domain table stays DELETE-denied.
//
// Observability (hard rule 6): scope names/aliases are user labels, not memory
// content, and are bounded by the schema; this module logs nothing and callers
// log ids/counts only.
import { and, asc, count, eq, isNotNull, isNull, type SQL } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { isUniqueViolation } from './pg-errors.js'
import { commitments, memories, scopes } from './schema/memory.js'

/** One scope-registry row, typed from the scopes table. */
export interface ScopeRow {
  id: string
  name: string
  aliases: string[]
  createdAt: Date
}

/**
 * Thrown when creating/renaming a scope collides with an existing name for the
 * tenant (the unique (user_id, name) index, SQLSTATE 23505). A typed domain
 * CONFLICT — never a leaked driver error — so the transport maps it to a typed
 * conflict result naming the colliding NAME (a user label, bounded, not content).
 */
export class ScopeNameConflictError extends Error {
  readonly scopeName: string
  constructor(scopeName: string) {
    super(`a scope named "${scopeName}" already exists for this tenant`)
    this.name = 'ScopeNameConflictError'
    this.scopeName = scopeName
  }
}

/**
 * Thrown when rename/set-aliases/delete targets a scope that does not exist for
 * the tenant. RLS hides cross-tenant rows, so not-found and not-owned collapse to
 * one mapping (memory-revise.ts precedent). Names the missing NAME only.
 */
export class ScopeNotFoundError extends Error {
  readonly scopeName: string
  constructor(scopeName: string) {
    super(`no scope named "${scopeName}" for this tenant`)
    this.name = 'ScopeNotFoundError'
    this.scopeName = scopeName
  }
}

const toScopeRow = (r: {
  id: string
  name: string
  aliases: string[]
  createdAt: Date
}): ScopeRow => ({ id: r.id, name: r.name, aliases: r.aliases, createdAt: r.createdAt })

const SCOPE_COLUMNS = {
  id: scopes.id,
  name: scopes.name,
  aliases: scopes.aliases,
  createdAt: scopes.createdAt,
} as const

/** List the tenant's registered scopes, ordered by name for a stable surface. */
export async function listScopes(tx: TenantTx, userId: string): Promise<ScopeRow[]> {
  const rows = await tx
    .select(SCOPE_COLUMNS)
    .from(scopes)
    .where(eq(scopes.userId, userId))
    .orderBy(asc(scopes.name))
  return rows.map(toScopeRow)
}

/**
 * Create a scope. Unique (user_id, name) collision -> {@link ScopeNameConflictError}.
 *
 * `userId` is REQUIRED on the insert: scopes.user_id is NOT NULL with no default,
 * and the bound app.user_id (RLS) does not populate the column — it only gates
 * visibility. The caller (core) supplies the same userId it opened withTenant
 * with, so the WITH CHECK RLS predicate (user_id = app.user_id) holds.
 */
export async function createScope(
  tx: TenantTx,
  userId: string,
  name: string,
  aliases: string[],
): Promise<ScopeRow> {
  try {
    const [row] = await tx.insert(scopes).values({ userId, name, aliases }).returning(SCOPE_COLUMNS)
    // .returning always yields exactly the inserted row on a successful INSERT.
    if (row === undefined) throw new Error('createScope insert returned no row')
    return toScopeRow(row)
  } catch (err) {
    if (isUniqueViolation(err)) throw new ScopeNameConflictError(name)
    throw err
  }
}

/** Rename a scope. Missing -> {@link ScopeNotFoundError}; new-name collision -> conflict. */
export async function renameScope(
  tx: TenantTx,
  userId: string,
  from: string,
  to: string,
): Promise<ScopeRow> {
  try {
    const [row] = await tx
      .update(scopes)
      .set({ name: to })
      .where(and(eq(scopes.userId, userId), eq(scopes.name, from)))
      .returning(SCOPE_COLUMNS)
    if (row === undefined) throw new ScopeNotFoundError(from)
    return toScopeRow(row)
  } catch (err) {
    if (isUniqueViolation(err)) throw new ScopeNameConflictError(to)
    throw err
  }
}

/** Replace a scope's alias list (full replace, not merge). Missing -> not-found. */
export async function setScopeAliases(
  tx: TenantTx,
  userId: string,
  name: string,
  aliases: string[],
): Promise<ScopeRow> {
  const [row] = await tx
    .update(scopes)
    .set({ aliases })
    .where(and(eq(scopes.userId, userId), eq(scopes.name, name)))
    .returning(SCOPE_COLUMNS)
  if (row === undefined) throw new ScopeNotFoundError(name)
  return toScopeRow(row)
}

/**
 * Delete a scope from the REGISTRY. Memory rows whose denormalized `scope` text
 * matches are UNTOUCHED (no FK, no cascade) — they keep the text and stay valid
 * (see module header). Missing -> {@link ScopeNotFoundError}.
 */
export async function deleteScope(tx: TenantTx, userId: string, name: string): Promise<void> {
  const deleted = await tx
    .delete(scopes)
    .where(and(eq(scopes.userId, userId), eq(scopes.name, name)))
    .returning({ id: scopes.id })
  if (deleted.length === 0) throw new ScopeNotFoundError(name)
}

// ---------------------------------------------------------------------------
// environment stats (describe_environment) — bounded COUNT queries only
// ---------------------------------------------------------------------------

/**
 * Bounded environment counts for describe_environment (docs/concepts/mcp-design.mdx "stats").
 * COUNT aggregates ONLY — never row content, names, or values (hard rule 6): the
 * caller surfaces capabilities/scopes/counts, never any env value or DSN.
 *
 * - `memoriesByType`   : LIVE-memory count per memory_type (status = 'active'
 *    AND valid_to IS NULL — the two-condition liveness shared with briefing-read)
 * - `activeMemories`   : total LIVE memories (status = 'active' AND valid_to IS NULL)
 * - `supersededMemories`: total memories that have been superseded (valid_to set)
 * - `archivedMemories` : total memories with status = 'archived' AND valid_to IS NULL
 * - `commitmentsByStatus`: commitment count per FSM status
 */
export interface EnvironmentStats {
  memoriesByType: Record<string, number>
  activeMemories: number
  supersededMemories: number
  archivedMemories: number
  commitmentsByStatus: Record<string, number>
}

const toCountMap = (rows: { key: string; n: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key, r.n]))

/**
 * The LIVE-memory predicate: the SAME two-condition liveness briefing-read.ts uses
 * (status = 'active' AND valid_to IS NULL). A bare status check overstates the live
 * total — an docs/concepts/memory-model.mdx revise leaves the superseded predecessor at status='active'
 * and marks it ONLY via valid_to, so without the valid_to gate every revise would
 * inflate `activeMemories` / `memoriesByType` (Codex P2, comment 3372115945).
 */
const liveMemoryPredicate = (userId: string): SQL =>
  and(eq(memories.userId, userId), eq(memories.status, 'active'), isNull(memories.validTo)) as SQL

/** Gather the bounded count aggregates for the tenant. Empty tenant -> all zeros. */
export async function getEnvironmentStats(tx: TenantTx, userId: string): Promise<EnvironmentStats> {
  const byType = await tx
    .select({ key: memories.memoryType, n: count() })
    .from(memories)
    .where(liveMemoryPredicate(userId))
    .groupBy(memories.memoryType)

  const [activeRow] = await tx
    .select({ n: count() })
    .from(memories)
    .where(liveMemoryPredicate(userId))

  // Superseded = a closed validity window (valid_to set), the docs/concepts/memory-model.mdx marker of
  // a memory that a successor replaced. NOT derived from status, which is a
  // separate axis (active/archived).
  const [supersededRow] = await tx
    .select({ n: count() })
    .from(memories)
    .where(and(eq(memories.userId, userId), isNotNull(memories.validTo)))

  // Archived = explicitly soft-deleted (status='archived') but still open-window
  // (valid_to IS NULL). A revise of an archived memory sets valid_to, so archived+
  // closed rows are counted under superseded — this avoids double-counting.
  const [archivedRow] = await tx
    .select({ n: count() })
    .from(memories)
    .where(
      and(eq(memories.userId, userId), eq(memories.status, 'archived'), isNull(memories.validTo)),
    )

  const byStatus = await tx
    .select({ key: commitments.status, n: count() })
    .from(commitments)
    .where(eq(commitments.userId, userId))
    .groupBy(commitments.status)

  return {
    memoriesByType: toCountMap(byType),
    activeMemories: activeRow?.n ?? 0,
    supersededMemories: supersededRow?.n ?? 0,
    archivedMemories: archivedRow?.n ?? 0,
    commitmentsByStatus: toCountMap(byStatus),
  }
}
