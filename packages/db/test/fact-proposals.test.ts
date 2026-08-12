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
import {
  insertFactProposals,
  listFactProposals,
  rejectFactProposal,
} from '../src/fact-proposals.js'
import { applyFactProposal } from '../src/fact-proposals-apply.js'

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

/** Capture the SQL + bound params a tx-taking helper emits, without a database. */
async function emitted(run: (tx: never) => Promise<unknown>): Promise<{
  sql: string
  params: unknown[]
}> {
  const seen: { sql: string; params: unknown[] }[] = []
  // drizzle's node-postgres session calls client.query(config, params) — the
  // bound values arrive as the SECOND argument, not on the config object.
  const client = {
    query: async (config: { text: string }, params: unknown[] = []) => {
      seen.push({ sql: config.text, params })
      return { rows: [], rowCount: 0 }
    },
  }
  const db = drizzle(client as never)
  await run(db as never).catch(() => undefined)
  const [first] = seen
  if (first === undefined) throw new Error('no statement emitted')
  return first
}

const USER = '00000000-0000-7000-8000-0000000000aa'
const PROPOSAL = '00000000-0000-7000-8000-0000000000bb'

describe('tenant binding is two-layer (explicit user_id, not RLS alone)', () => {
  // These would all still PASS a cross-tenant integration test with RLS intact:
  // the policy hides the row either way. They fail only if the explicit
  // predicate is dropped — which is exactly the layer that has to survive a
  // query running outside withTenant(), a dropped policy, or a BYPASSRLS role.
  it('listFactProposals filters on the caller user_id', async () => {
    const { sql, params } = await emitted((tx) => listFactProposals(tx, USER, {}))
    expect(sql).toContain('"user_id" =')
    expect(params).toContain(USER)
  })

  it('listFactProposals keeps the user_id filter alongside a status filter', async () => {
    const { sql, params } = await emitted((tx) =>
      listFactProposals(tx, USER, { status: 'proposed' }),
    )
    expect(sql).toContain('"user_id" =')
    expect(params).toEqual(expect.arrayContaining([USER, 'proposed']))
  })

  it('rejectFactProposal pins user_id in addition to id and status', async () => {
    const { sql, params } = await emitted((tx) => rejectFactProposal(tx, USER, PROPOSAL))
    expect(sql).toContain('"user_id" =')
    expect(params).toEqual(expect.arrayContaining([USER, PROPOSAL, 'proposed']))
  })

  it('applyFactProposal pins user_id on the claiming update', async () => {
    const { sql, params } = await emitted((tx) => applyFactProposal(tx, USER, PROPOSAL))
    expect(sql).toContain('update "fact_proposals"')
    expect(sql).toContain('"user_id" =')
    expect(params).toEqual(expect.arrayContaining([USER, PROPOSAL, 'proposed']))
  })

  it('inserted rows carry the caller user_id', async () => {
    const { params } = await emitted((tx) =>
      insertFactProposals(tx, [
        {
          userId: USER,
          memoryId: PROPOSAL,
          subject: 's',
          predicate: 'p',
          value: 'v',
          memoryType: 'fact',
        },
      ]),
    )
    expect(params).toContain(USER)
  })
})
