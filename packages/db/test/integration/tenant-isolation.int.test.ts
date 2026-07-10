// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 1 (docs/concepts/testing.mdx): tenant isolation across EVERY query path —
// memories, edges, facts, commitments, proposals — as the runtime role.

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, withTenant } from '../../src/client.js'
import { closePools, resetDomainTables, seedUser } from './helpers.js'

let a: string
let b: string

beforeAll(async () => {
  a = await seedUser('iso-a@test.local')
  b = await seedUser('iso-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

async function seedTenantA() {
  return withTenant(a, async (tx) => {
    const m1 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'fact', 'a-topic', 'a-content', 'h1') RETURNING id`,
    )
    const m2 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'commitment', 'a-c', 'a-c', 'h2') RETURNING id`,
    )
    const id1 = m1.rows[0].id as string
    const id2 = m2.rows[0].id as string
    await tx.execute(
      sql`INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
          VALUES (${a}, ${id2}, ${id1}, 'extends', 'user_api')`,
    )
    await tx.execute(
      sql`INSERT INTO facts (user_id, memory_id, subject, predicate, value)
          VALUES (${a}, ${id1}, 's', 'p', 'v')`,
    )
    await tx.execute(sql`INSERT INTO commitments (user_id, memory_id) VALUES (${a}, ${id2})`)
    await tx.execute(
      sql`INSERT INTO consolidation_proposals (user_id, from_id, to_id, edge_type, memory_type, similarity)
          VALUES (${a}, ${id2}, ${id1}, 'extends', 'fact', 0.93)`,
    )
    return { id1, id2 }
  })
}

describe('tenant isolation (runtime role, real withTenant)', () => {
  it('tenant B sees nothing of A across all five query paths', async () => {
    await seedTenantA()
    const counts = await withTenant(b, async (tx) => {
      const q = async (t: string) =>
        Number((await tx.execute(sql.raw(`SELECT count(*) AS n FROM ${t}`))).rows[0]?.n)
      return {
        memories: await q('memories'),
        edges: await q('memory_edges'),
        facts: await q('facts'),
        commitments: await q('commitments'),
        proposals: await q('consolidation_proposals'),
      }
    })
    expect(counts).toEqual({ memories: 0, edges: 0, facts: 0, commitments: 0, proposals: 0 })
  })

  it('tenant A sees own rows through ALL five paths (positive visibility)', async () => {
    await seedTenantA()
    const counts = await withTenant(a, async (tx) => {
      const q = async (t: string) =>
        Number((await tx.execute(sql.raw(`SELECT count(*) AS n FROM ${t}`))).rows[0]?.n)
      return {
        memories: await q('memories'),
        edges: await q('memory_edges'),
        facts: await q('facts'),
        commitments: await q('commitments'),
        proposals: await q('consolidation_proposals'),
      }
    })
    expect(counts).toEqual({ memories: 2, edges: 1, facts: 1, commitments: 1, proposals: 1 })
  })

  it('forged cross-tenant write is rejected by WITH CHECK', async () => {
    await expect(
      withTenant(b, (tx) =>
        tx.execute(
          sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
              VALUES (${a}, 'note', 'forged', 'x', 'hf')`,
        ),
      ),
    ).rejects.toSatisfy((e: Error) =>
      /row-level security/.test(String((e as { cause?: unknown }).cause ?? e)),
    )
  })

  it('cross-tenant edge is unrepresentable (RLS hides the foreign endpoint; composite FK backstops)', async () => {
    const { id1 } = await seedTenantA()
    // B creates own memory, then tries to edge onto A's
    await expect(
      withTenant(b, async (tx) => {
        const own = await tx.execute(
          sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
              VALUES (${b}, 'note', 'b', 'b', 'hb') RETURNING id`,
        )
        await tx.execute(
          sql`INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
              VALUES (${b}, ${own.rows[0].id as string}, ${id1}, 'extends', 'user_api')`,
        )
      }),
    ).rejects.toSatisfy((e: Error) =>
      /foreign key|violates/.test(String((e as { cause?: unknown }).cause ?? e)),
    )
  })
})
