// SPDX-License-Identifier: Apache-2.0
// Unit tests for the bi-temporal time-window predicate builders (slice 2).
//
// These compile the drizzle SQL fragments through the real PgDialect and assert
// on the generated SQL + bound params — no database, no withTenant. The
// integration suite (facts-read.int.test.ts) covers the runtime-role behavior;
// this isolates the window LOGIC: current-row default vs valid-time window, and
// the transaction-time clause emission.
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { transactionTimePredicate, validTimePredicate } from '../src/facts-read.js'

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
