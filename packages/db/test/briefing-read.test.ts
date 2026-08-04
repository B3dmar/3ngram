// SPDX-License-Identifier: Apache-2.0
// Unit tests for the orientation selector predicate (issue #46).
//
// Compiles memoryScopePredicate through the real PgDialect and asserts on the
// generated SQL + bound params — no database, no withTenant (the facts-read
// predicate-testing precedent). This isolates the SELECTOR MATRIX: all four
// kinds, with scope_project exercised under includeUnscoped on AND off. The
// integration suite (briefing-read.int.test.ts) covers the runtime behavior;
// every briefing section + handoff inherits this ONE predicate, so the matrix
// here covers them all.
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { memoryScopePredicate } from '../src/briefing-read.js'

const dialect = new PgDialect()
const compile = (selector: Parameters<typeof memoryScopePredicate>[0]) => {
  const predicate = memoryScopePredicate(selector)
  if (predicate === undefined) throw new Error('expected a predicate')
  return dialect.sqlToQuery(predicate)
}

describe('memoryScopePredicate — selector matrix', () => {
  it('all: no narrowing (undefined, no clause emitted)', () => {
    expect(memoryScopePredicate({ kind: 'all' })).toBeUndefined()
  })

  it('scope: a single scope equality', () => {
    const { sql, params } = compile({ kind: 'scope', scope: 'work' })
    expect(sql).toContain('scope')
    expect(sql).toContain('=')
    expect(sql).not.toContain('project')
    expect(params).toEqual(['work'])
  })

  it('project: a single project equality (NULL-project rows never match)', () => {
    const { sql, params } = compile({ kind: 'project', project: '3ngram' })
    expect(sql).toContain('project')
    expect(sql).toContain('=')
    expect(sql).not.toContain('scope')
    expect(sql.toLowerCase()).not.toContain('is null')
    expect(params).toEqual(['3ngram'])
  })

  it('scope_project, includeUnscoped: false — strict intersection, no NULL branch', () => {
    const { sql, params } = compile({
      kind: 'scope_project',
      scope: 'work',
      project: '3ngram',
      includeUnscoped: false,
    })
    expect(sql).toContain('scope')
    expect(sql).toContain('project')
    expect(sql.toLowerCase()).toContain('and')
    // Strict: no dead OR/IS NULL clause rides the plan when the flag is off.
    expect(sql.toLowerCase()).not.toContain('is null')
    expect(sql.toLowerCase()).not.toContain(' or ')
    expect(params).toEqual(['work', '3ngram'])
  })

  it('scope_project, includeUnscoped: true — scope AND (project OR project IS NULL)', () => {
    const { sql, params } = compile({
      kind: 'scope_project',
      scope: 'work',
      project: '3ngram',
      includeUnscoped: true,
    })
    expect(sql).toContain('scope')
    expect(sql).toContain('project')
    expect(sql.toLowerCase()).toContain('and')
    expect(sql.toLowerCase()).toContain(' or ')
    expect(sql.toLowerCase()).toContain('is null')
    // The NULL widening is grouped with the project match, never with scope:
    // the scope equality stays unconditional.
    expect(sql.toLowerCase()).toMatch(/\(.*project.*=.*or.*project.*is null.*\)/)
    expect(params).toEqual(['work', '3ngram'])
  })
})
