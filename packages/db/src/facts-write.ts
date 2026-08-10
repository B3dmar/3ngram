// SPDX-License-Identifier: Apache-2.0
// Fact persistence — the structured projection of a memory (docs/concepts/data-model.mdx).
//
// A facts row is (subject, predicate, value) with bi-temporal validity and a
// composite FK back to the memory that asserted it. These helpers take a
// caller-supplied TenantTx rather than opening their own transaction — the
// insertEdge precedent (memory-edges.ts) — so a memory and the facts it
// asserts land, or roll back, together. The withTenant() wrapper and the
// target-existence probe stay with the callers that attach facts to a
// PRE-EXISTING memory (memory-import.ts); the fresh-write path already holds
// the tx and the just-inserted memory id.
//
// Append-only (hard rule 1): these only ever INSERT. No uniqueness applies —
// bi-temporal history keeps every assertion, and "currently true" is a validity
// query, not a constraint (schema/memory.ts facts rationale). The runtime role
// has no DELETE on facts (provision-roles.sql / append-only.int.test.ts).
//
// Observability (hard rule 6): ids only — subject/predicate/value are memory
// content and never reach a log, error message, or metric.
import type { TenantTx } from './client.js'
import { facts } from './schema/memory.js'

/** Persisted columns for one fact. `userId` scopes the row; RLS binds the tenant. */
export interface FactWrite {
  userId: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  confidence?: number | undefined
  /** Omitted -> column default now(). */
  validFrom?: Date | undefined
  /** Open-ended (still true) when omitted. */
  validTo?: Date | undefined
  /** Original knowledge time from a source system (import path); omitted -> now(). */
  recordedAt?: Date | undefined
}

/**
 * The fact columns a caller supplies when the owning memory is written in the
 * SAME transaction ({@link writeMemory}): tenant and memory id are not the
 * caller's to choose — they come from that write.
 */
export type MemoryFactWrite = Omit<FactWrite, 'userId' | 'memoryId'>

/**
 * Insert facts inside the caller's tenant-scoped transaction, returning the new
 * ids POSITIONALLY — `result[i]` is the id of `rows[i]`. A multi-row INSERT
 * ... RETURNING emits rows in values order, and the row-count check below makes
 * that correspondence total rather than assumed.
 *
 * One statement, not a loop: a memory can assert several facts at once and an
 * insert-per-fact would be an N+1 on the write path.
 *
 * Empty input short-circuits WITHOUT touching the transaction: drizzle rejects
 * an empty VALUES list, and the fresh-write path calls this unconditionally so
 * that a memory carrying no facts still costs exactly zero extra statements.
 *
 * This helper maps NO driver errors. It is deliberately not the insertEdge
 * shape (which owns a unique-violation -> EdgeConflictError mapping) because
 * facts carries no unique index for a collision to come from; see the
 * duplicate-mapping note in {@link writeMemory}.
 */
export async function insertFacts(tx: TenantTx, rows: readonly FactWrite[]): Promise<string[]> {
  if (rows.length === 0) return []
  const inserted = await tx
    .insert(facts)
    .values(
      rows.map((row) => ({
        userId: row.userId,
        memoryId: row.memoryId,
        subject: row.subject,
        predicate: row.predicate,
        value: row.value,
        confidence: row.confidence,
        // Undefined values are omitted by drizzle, so an unspecified column
        // keeps its schema default (now() / NULL) instead of being written.
        validFrom: row.validFrom,
        validTo: row.validTo,
        recordedAt: row.recordedAt,
      })),
    )
    .returning({ id: facts.id })
  if (inserted.length !== rows.length) {
    throw new Error(`insertFacts inserted ${inserted.length} of ${rows.length} rows`)
  }
  return inserted.map((row) => row.id)
}

/** Single-fact {@link insertFacts}, for callers that attach one fact at a time. */
export async function insertFact(tx: TenantTx, fact: FactWrite): Promise<{ id: string }> {
  const [id] = await insertFacts(tx, [fact])
  if (!id) throw new Error('insertFact returned no row')
  return { id }
}
