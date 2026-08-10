// SPDX-License-Identifier: Apache-2.0
// Unit tests for the fact-proposal SQL shape — no database.
//
// The ON CONFLICT target is a CONTRACT with migration 0031. Postgres INFERS
// which index to use from the target, and `fact_proposals_open_idx` is both
// PARTIAL and built on an EXPRESSION, so the statement must name the same
// columns, the same md5() expression, AND the same WHERE predicate. Anything
// less specific matches no index and the INSERT fails outright.
//
// This runs production's own query builder through a fake driver and reads the
// SQL it actually emits, so the assertion cannot drift from the code the way a
// hand-written expected string would.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import { insertFactProposals } from '../src/fact-proposals.js'

/** Collapse the template's whitespace so assertions read as one line. */
const normalize = (sql: string) => sql.replaceAll(/\s+/g, ' ').trim()

const migrationSql = readFileSync(
  join(import.meta.dirname, '../migrations/0031_fact_proposals.sql'),
  'utf8',
)

/** Run the helper against a driver that records SQL instead of executing it. */
async function emittedSql(): Promise<string> {
  const statements: string[] = []
  const client = {
    query: async (config: { text: string }) => {
      statements.push(config.text)
      return { rows: [], rowCount: 0 }
    },
  }
  const db = drizzle(client as never)
  await insertFactProposals(db as never, [
    {
      userId: '00000000-0000-7000-8000-000000000001',
      memoryId: '00000000-0000-7000-8000-000000000002',
      subject: 'lift.back_squat',
      predicate: 'top_set.weight_kg',
      value: '98',
      memoryType: 'fact',
    },
  ])
  const [statement] = statements
  if (statement === undefined) throw new Error('insertFactProposals emitted no statement')
  return statement
}

describe('insertFactProposals ON CONFLICT target', () => {
  it('mirrors fact_proposals_open_idx: same columns, md5 expression, and predicate', async () => {
    const sql = await emittedSql()
    // The inference target, in index column order, with `value` DIGESTED —
    // naming the bare column here would match no index.
    expect(normalize(sql)).toContain(
      "ON CONFLICT (user_id, memory_id, subject, predicate, md5(value)) WHERE status = 'proposed' DO NOTHING",
    )
  })

  it('emits the same key the migration indexes (drift guard, both directions)', async () => {
    const sql = await emittedSql()
    // Derive the index's key from the migration rather than restating it, so a
    // change to either side has to be made on both.
    const indexKey = migrationSql.match(
      /CREATE UNIQUE INDEX "fact_proposals_open_idx"[^(]*\(([^)]*\)[^)]*)\) WHERE (status = 'proposed')/,
    )
    expect(indexKey, 'fact_proposals_open_idx not found in migration 0031').not.toBeNull()
    const columns = (indexKey?.[1] ?? '').replaceAll('"', '').replaceAll(' ', '').split(',')
    const emitted = (normalize(sql).match(/ON CONFLICT \(([^)]*\)[^)]*)\)/)?.[1] ?? '')
      .replaceAll(' ', '')
      .split(',')
    expect(emitted).toEqual(columns)
    expect(normalize(sql)).toContain(`WHERE ${indexKey?.[2]}`)
  })

  it('writes every proposal as status proposed, never an already-decided row', async () => {
    const sql = await emittedSql()
    expect(normalize(sql)).toContain('INSERT INTO fact_proposals')
    expect(sql).not.toMatch(/'applied'|'rejected'/)
  })
})

describe('insertFactProposals', () => {
  it('short-circuits on empty input without touching the transaction', async () => {
    const unusableTx = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`insertFactProposals touched the transaction: .${String(property)}`)
        },
      },
    ) as never
    await expect(insertFactProposals(unusableTx, [])).resolves.toBe(0)
  })
})
