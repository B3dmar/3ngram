// SPDX-License-Identifier: Apache-2.0
// Unit tests for the bi-temporal time-window predicate builders (slice 2) and
// the range-mode ordering (time-series reads).
//
// These compile the drizzle SQL fragments through the real PgDialect and assert
// on the generated SQL + bound params — no database, no withTenant. The
// integration suite (facts-read.int.test.ts) covers the runtime-role behavior
// (row-level ordering with real data); this isolates the window LOGIC:
// current-row default vs valid-time window vs range overlap, the
// transaction-time clause emission, and which columns the range-mode ORDER BY
// compiles to.
import { asc } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  getFacts,
  transactionTimePredicate,
  validityOverlapPredicate,
  validTimePredicate,
} from '../src/facts-read.js'
import { facts } from '../src/schema/memory.js'

const dialect = new PgDialect()
const compile = (sql: ReturnType<typeof validTimePredicate>) => dialect.sqlToQuery(sql)

describe('validTimePredicate (valid-time axis)', () => {
  it('current-row default selects the live fact (valid_to IS NULL)', () => {
    const { sql, params } = compile(validTimePredicate())
    expect(sql).toContain('valid_to')
    expect(sql.toLowerCase()).toContain('is null')
    // a bare IS NULL check binds no instant
    expect(params).toHaveLength(0)
  })

  it('validAt selects the half-open window [valid_from, valid_to)', () => {
    const at = new Date('2026-03-01T00:00:00.000Z')
    const { sql, params } = compile(validTimePredicate(at))
    // valid_from <= at AND (valid_to IS NULL OR valid_to > at): the open-ended
    // window stays selectable, and the upper bound is strict (>) so a
    // successor's valid_from == predecessor's valid_to never double-counts.
    expect(sql).toContain('valid_from')
    expect(sql).toContain('valid_to')
    expect(sql.toLowerCase()).toContain('<=')
    expect(sql).toContain('>')
    expect(sql.toLowerCase()).toContain('is null')
    expect(sql.toLowerCase()).toContain('or')
    // the instant is bound twice (lower bound + strict upper bound); drizzle
    // serializes a Date param to its ISO string for the timestamp typing.
    expect(params).toEqual([at.toISOString(), at.toISOString()])
  })
})

describe('validityOverlapPredicate (range mode, time-series reads)', () => {
  it('an empty range ({}) returns undefined — no clause to emit, never "match everything"', () => {
    // Directly asserts the WHERE-collapse footgun stays closed: and(...[]) is
    // undefined at runtime, and this function must surface that, never a
    // fabricated always-true SQL fragment (getFacts turns this into a thrown
    // error via requireRangeCondition — see the describe block below).
    expect(validityOverlapPredicate({})).toBeUndefined()
  })

  it('both bounds: valid_from < to AND (valid_to IS NULL OR valid_to > from)', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const to = new Date('2026-06-01T00:00:00.000Z')
    const { sql, params } = compile(validityOverlapPredicate({ from, to }))
    expect(sql).toContain('valid_from')
    expect(sql).toContain('valid_to')
    expect(sql).toContain('<')
    expect(sql).toContain('>')
    expect(sql.toLowerCase()).toContain('is null')
    expect(sql.toLowerCase()).toContain('or')
    // to binds the valid_from upper bound; from binds the valid_to lower bound.
    expect(params).toEqual([to.toISOString(), from.toISOString()])
  })

  it('from-only (open end): only the valid_to lower-bound clause is emitted', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const { sql, params } = compile(validityOverlapPredicate({ from }))
    expect(sql).not.toContain('valid_from')
    expect(sql).toContain('valid_to')
    expect(sql.toLowerCase()).toContain('is null')
    expect(params).toEqual([from.toISOString()])
  })

  it('to-only (open start): only the valid_from upper-bound clause is emitted', () => {
    const to = new Date('2026-06-01T00:00:00.000Z')
    const { sql, params } = compile(validityOverlapPredicate({ to }))
    expect(sql).toContain('valid_from')
    expect(sql).not.toContain('valid_to')
    expect(params).toEqual([to.toISOString()])
  })
})

describe('range-mode ORDER BY (asc(validFrom), asc(id))', () => {
  it('compiles to valid_from then id, both ascending — no DESC anywhere', () => {
    // getFacts flips ORDER BY to this pair in range mode (facts-read.ts); the
    // full-query build (select/from/orderBy/limit) needs a live tx, so — same
    // precedent as briefing-read.test.ts — this compiles the order EXPRESSIONS
    // directly rather than the whole query.
    const validFromAsc = dialect.sqlToQuery(asc(facts.validFrom))
    const idAsc = dialect.sqlToQuery(asc(facts.id))
    expect(validFromAsc.sql).toContain('valid_from')
    expect(validFromAsc.sql.toLowerCase()).not.toContain('desc')
    expect(idAsc.sql).toContain('id')
    expect(idAsc.sql.toLowerCase()).not.toContain('desc')
  })
})

describe('getFacts — range-mode empty-range guard', () => {
  it('throws before touching the tx when range is {} (schema boundary should have rejected it first)', async () => {
    // requireRangeCondition() must reject BEFORE getFacts builds the select
    // query, so a stub tx (never touched) is enough to prove the throw is
    // synchronous-before-query — no live db, no withTenant.
    const untouchedTx = {
      select: () => {
        throw new Error('should never be reached — the empty-range guard must throw first')
      },
    } as unknown as Parameters<typeof getFacts>[0]
    await expect(getFacts(untouchedTx, 'user-1', { range: {} })).rejects.toThrow(
      /range mode requires from or to/,
    )
  })
})

describe('transactionTimePredicate (transaction-time axis)', () => {
  it('returns undefined when asKnownAt is omitted (no clause emitted)', () => {
    expect(transactionTimePredicate()).toBeUndefined()
  })

  it('asKnownAt restricts to rows recorded by that instant (recorded_at <= t)', () => {
    const at = new Date('2026-03-01T00:00:00.000Z')
    const predicate = transactionTimePredicate(at)
    expect(predicate).toBeDefined()
    const { sql, params } = compile(predicate as ReturnType<typeof validTimePredicate>)
    expect(sql).toContain('recorded_at')
    expect(sql.toLowerCase()).toContain('<=')
    expect(params).toEqual([at.toISOString()])
  })
})
