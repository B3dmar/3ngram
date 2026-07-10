// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 2 (docs/concepts/testing.mdx, spike S3 graduate): withTenant() leaves no
// context residue under concurrency, and unscoped reads fail closed.

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, withTenant } from '../../src/client.js'
import { closePools, resetDomainTables, runtimePool, seedUser } from './helpers.js'

const tenants: string[] = []

beforeAll(async () => {
  for (let i = 0; i < 10; i++) tenants.push(await seedUser(`disc-${i}@test.local`))
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('withTenant discipline (S3 T4/T5 as a permanent suite)', () => {
  it('no-context read returns zero rows and does NOT throw (NULLIF guard)', async () => {
    await withTenant(tenants[0] as string, (tx) =>
      tx.execute(
        sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
            VALUES (${tenants[0] as string}, 'note', 't', 'c', 'hd')`,
      ),
    )
    const r = await runtimePool.query('SELECT count(*) AS n FROM memories')
    expect(Number(r.rows[0].n)).toBe(0)
  })

  it('SET LOCAL leaves no residue on pooled connections', async () => {
    await withTenant(tenants[1] as string, async () => {})
    for (let i = 0; i < 16; i++) {
      const r = await runtimePool.query(`SELECT current_setting('app.user_id', true) AS v`)
      expect(r.rows[0].v ?? '').toBe('')
    }
  })

  it('100 concurrent withTenant ops across 10 tenants: zero cross-tenant reads', async () => {
    let violations = 0
    await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const t = tenants[i % tenants.length] as string
        await withTenant(t, async (tx) => {
          await tx.execute(
            sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
                VALUES (${t}, 'note', ${`op-${i}`}, 'c', ${`h-${i}`})`,
          )
          const rows = await tx.execute(sql`SELECT DISTINCT user_id FROM memories`)
          if (rows.rows.some((r) => r.user_id !== t)) violations++
        })
      }),
    )
    expect(violations).toBe(0)
  }, 60_000) // Neon-over-WAN latency in CI; local runs finish in <1s
})
