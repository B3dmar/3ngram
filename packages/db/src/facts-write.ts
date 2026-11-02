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
// Append-and-supersede (hard rule 1): rows are only ever INSERTed, and an
// existing row changes in exactly one way, by closing its validity window
// (`valid_to` set, never rewritten or reopened). No uniqueness applies:
// bi-temporal history keeps every assertion, and "currently true" is a
// validity query, not a constraint (schema/memory.ts facts rationale). The
// runtime role has no DELETE on facts (provision-roles.sql / append-only.int.test.ts).
//
// SINGLE-VALUED BY DEFAULT (issue #369). A fact key is (subject, predicate).
// Unless a write marks a fact `cardinality: 'many'`, a new value REPLACES the
// key's current value: it closes every open value of the key that started at
// or before it, at its own start, and a backdated value is stored as history
// that ends where the next newer open value starts. A write only ever closes
// an EXISTING value at its own start, so it never invents an end time for an
// existing value from another row. A row written with its own `validTo` is a closed interval and
// takes no part. Import replays exported history verbatim and opts out
// (`supersede: false`).
//
// Observability (hard rule 6): ids only — subject/predicate/value are memory
// content and never reach a log, error message, or metric.
import { and, eq, gt, isNull, lte, type SQL, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { facts } from './schema/memory.js'

/**
 * How a fact relates to other values of the same (subject, predicate):
 * `one` (the default) replaces the current value, `many` coexists with it.
 */
export type FactCardinality = 'one' | 'many'

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
  /** Omitted -> `one`: the value replaces the key's current value (issue #369). */
  cardinality?: FactCardinality | undefined
}

/** Options for {@link insertFacts}. */
export interface InsertFactsOptions {
  /**
   * Chain single-valued keys so one value stays current (issue #369). Default
   * true. Import passes false: it replays exported windows exactly as they were.
   */
  supersede?: boolean
}

/**
 * The fact columns a caller supplies when the owning memory is written in the
 * SAME transaction ({@link writeMemory}): tenant and memory id are not the
 * caller's to choose — they come from that write.
 */
export type MemoryFactWrite = Omit<FactWrite, 'userId' | 'memoryId'>

/**
 * Insert facts inside the caller's tenant-scoped transaction, returning the new
 * ids POSITIONALLY: `result[i]` is the id of `rows[i]`.
 *
 * Rows that take no part in supersession (import, `cardinality: 'many'`, or a
 * caller-supplied `validTo`) go in ONE multi-row INSERT ... RETURNING, which
 * emits rows in values order; the row-count check makes that correspondence
 * total rather than assumed. They are written after the single-valued rows, so
 * a `many` value never closes, nor is closed by, a value of the same call.
 * Single-valued rows are written one at a time ({@link replaceValue}): two
 * statements per row plus one lock per key, small because a memory asserts
 * few facts.
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
export async function insertFacts(
  tx: TenantTx,
  rows: readonly FactWrite[],
  options: InsertFactsOptions = {},
): Promise<string[]> {
  if (rows.length === 0) return []
  const ids = new Array<string>(rows.length)
  const plain: number[] = []
  const byKey = new Map<string, number[]>()
  rows.forEach((row, index) => {
    if (options.supersede === false || row.cardinality === 'many' || row.validTo !== undefined) {
      plain.push(index)
      return
    }
    const key = JSON.stringify([row.userId, row.subject, row.predicate])
    byKey.set(key, [...(byKey.get(key) ?? []), index])
  })
  if (byKey.size > 0) await writeSingleValued(tx, rows, byKey, ids)
  if (plain.length > 0) {
    const plainIds = await insertPlain(
      tx,
      plain.map((index) => rows[index] as FactWrite),
    )
    plain.forEach((index, i) => {
      ids[index] = plainIds[i] as string
    })
  }
  return ids
}

/** Single-fact {@link insertFacts}, for callers that attach one fact at a time. */
export async function insertFact(
  tx: TenantTx,
  fact: FactWrite,
  options: InsertFactsOptions = {},
): Promise<{ id: string }> {
  const [id] = await insertFacts(tx, [fact], options)
  if (!id) throw new Error('insertFact returned no row')
  return { id }
}

/** The persisted columns of one row; undefined values keep the schema default. */
function factColumns(row: FactWrite) {
  return {
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
  }
}

async function insertPlain(tx: TenantTx, rows: readonly FactWrite[]): Promise<string[]> {
  const inserted = await tx.insert(facts).values(rows.map(factColumns)).returning({ id: facts.id })
  if (inserted.length !== rows.length) {
    throw new Error(`insertFacts inserted ${inserted.length} of ${rows.length} rows`)
  }
  return inserted.map((row) => row.id)
}

/**
 * Write the single-valued rows, grouped by key, filling `ids` positionally.
 *
 * A transaction-scoped advisory lock per key serializes concurrent writers of
 * that key: without it, two writes could each miss the other's new value and
 * both leave theirs open. Keys are locked in one sorted order, so two writers
 * of overlapping keys cannot deadlock. A value written without `validFrom`
 * starts at its transaction's start (`now()`), so concurrent values of a key
 * are ordered by transaction start, not by commit.
 *
 * Within one call, each value of a key ends no later than the next value of
 * that key in start order, so a series never overlaps itself, even when it
 * lands below a newer open value as history.
 */
async function writeSingleValued(
  tx: TenantTx,
  rows: readonly FactWrite[],
  byKey: ReadonlyMap<string, number[]>,
  ids: string[],
): Promise<void> {
  const needsOrder = [...byKey.values()].some((group) => group.length > 1)
  const now = needsOrder ? await transactionStart(tx) : undefined
  for (const key of [...byKey.keys()].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`facts:${key}`}, 0))`)
    const ordered = byStart(byKey.get(key) ?? [], rows, now)
    for (const [position, index] of ordered.entries()) {
      const next = ordered[position + 1]
      const nextInCall = next === undefined ? undefined : startOf(rows[next] as FactWrite)
      ids[index] = await replaceValue(tx, rows[index] as FactWrite, nextInCall)
    }
  }
}

async function transactionStart(tx: TenantTx): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`SELECT now() AS now`)
  const now = result.rows[0]?.now
  if (now === undefined) throw new Error('insertFacts: now() returned no row')
  return new Date(now)
}

/**
 * One key's row indexes ordered by start, so a series written in one call
 * forms a chain. A row without `validFrom` starts at `now()`, which keeps
 * microseconds that `now` (a JS Date) drops, so it sorts after an explicit
 * instant in the same millisecond. The sort is stable: input order breaks
 * the remaining ties, and the last write of an instant wins.
 */
function byStart(indexes: number[], rows: readonly FactWrite[], now: Date | undefined): number[] {
  if (indexes.length < 2) return indexes
  const start = (index: number) => (rows[index]?.validFrom ?? now)?.getTime() ?? 0
  const implicit = (index: number) => Number(rows[index]?.validFrom === undefined)
  return [...indexes].sort((a, b) => start(a) - start(b) || implicit(a) - implicit(b))
}

/** A row's start as SQL: its explicit instant, or the transaction start. */
function startOf(row: FactWrite): SQL {
  return row.validFrom === undefined ? sql`now()` : sql`${row.validFrom.toISOString()}::timestamptz`
}

/**
 * Write one single-valued row as the key's new value (issue #369):
 *
 * 1. Close every open value of the key that started at or before this row,
 *    at this row's start. A tie closes the older value as an empty window,
 *    which `facts_validity_check` allows, so the last write of an instant wins.
 * 2. Insert this row open, or as history that ends where the earliest newer
 *    open value starts, or where the next value of the same call starts,
 *    whichever comes first (`LEAST` ignores a NULL). `GREATEST` with the
 *    row's own start keeps the window valid even if the driver ever rounded
 *    the JS `now` that {@link byStart} sorts by, rather than truncating it.
 *
 * Every instant stays in SQL, so it keeps the microsecond precision a JS Date
 * would drop and a closed value ends exactly where its successor starts.
 *
 * Append-only limit: a value already closed by an earlier write is never
 * shortened, so a value backdated into its window overlaps it in history.
 */
async function replaceValue(tx: TenantTx, row: FactWrite, nextInCall?: SQL): Promise<string> {
  const start = startOf(row)
  const openForKey = and(
    eq(facts.userId, row.userId),
    eq(facts.subject, row.subject),
    eq(facts.predicate, row.predicate),
    isNull(facts.validTo),
  )
  await tx
    .update(facts)
    .set({ validTo: start })
    .where(and(openForKey, lte(facts.validFrom, start)))
  const nextOpen = sql`(SELECT min(${facts.validFrom}) FROM ${facts} WHERE ${and(openForKey, gt(facts.validFrom, start))})`
  const end =
    nextInCall === undefined ? nextOpen : sql`GREATEST(${start}, LEAST(${nextInCall}, ${nextOpen}))`
  const [inserted] = await tx
    .insert(facts)
    .values({ ...factColumns(row), validFrom: start, validTo: end })
    .returning({ id: facts.id })
  if (!inserted) throw new Error('insertFacts inserted no row')
  return inserted.id
}
