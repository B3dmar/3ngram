// SPDX-License-Identifier: Apache-2.0
// Behavioral proof for the runtime RLS guard (src/rls-guard.ts) and for FORCE
// ROW LEVEL SECURITY, run as the RUNTIME role (app_user, NOBYPASSRLS) against an
// ephemeral DB. This REPLACES the string-match proof (migration-drift.test.ts
// asserts NOBYPASSRLS/FORCE appear in the SQL text) with an assertion about the
// LIVE database — the only thing that actually protects tenants.
//
// Model: scripts/ci-smoke-app.sql (unscoped read = 0 rows, A-sees-own/B-sees-
// nothing). Here we additionally prove the guard passes on a correct DB and
// FAILS CLOSED against a bypass-capable (owner) connection and a mis-forced set.

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, withTenant } from '../../src/client.js'
import { assertRlsInForce, RlsGuardError, readForcedTenantTables } from '../../src/rls-guard.js'
import { closePools, ownerPool, resetDomainTables, runtimePool, seedUser } from './helpers.js'

// Forced tenant-data tables the runtime role (app_user) may SELECT and that this
// suite seeds for tenant A, so "B sees 0" is a real cross-tenant probe (not a
// vacuous count over empty tables). The full forced set — including billing
// tables the runtime role is not granted SELECT on — is proven at the catalog
// level by assertRlsInForce below.
const SEEDED_FORCED_TABLES = [
  'memories',
  'memory_edges',
  'facts',
  'commitments',
  'consolidation_proposals',
  'memory_events',
  'llm_usage',
] as const

let a: string
let b: string

beforeAll(async () => {
  a = await seedUser('rls-guard-a@test.local')
  b = await seedUser('rls-guard-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

async function seedTenantA(): Promise<void> {
  await withTenant(a, async (tx) => {
    const m1 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'fact', 'a-topic', 'a-content', 'gh1') RETURNING id`,
    )
    const m2 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'commitment', 'a-c', 'a-c', 'gh2') RETURNING id`,
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
    await tx.execute(
      sql`INSERT INTO memory_events (user_id, memory_id, event_kind)
          VALUES (${a}, ${id1}, 'create')`,
    )
    await tx.execute(
      sql`INSERT INTO llm_usage (user_id, operation, model, input_tokens, output_tokens)
          VALUES (${a}, 'memory.embed', 'text-embedding-3-small', 5, 0)`,
    )
  })
}

async function countAll(userId: string): Promise<Record<string, number>> {
  return withTenant(userId, async (tx) => {
    const out: Record<string, number> = {}
    for (const t of SEEDED_FORCED_TABLES) {
      const r = await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`))
      out[t] = Number(r.rows[0]?.n)
    }
    return out
  })
}

describe('FORCE RLS behavioral isolation (runtime role, real withTenant)', () => {
  it('tenant B sees ZERO rows of A across every seeded forced table', async () => {
    await seedTenantA()
    const counts = await countAll(b)
    for (const t of SEEDED_FORCED_TABLES) {
      expect(counts[t], `tenant B leaked rows from forced table ${t}`).toBe(0)
    }
  })

  it('tenant A still sees its own rows through the same forced tables (not over-blocked)', async () => {
    await seedTenantA()
    const counts = await countAll(a)
    expect(counts).toEqual({
      memories: 2,
      memory_edges: 1,
      facts: 1,
      commitments: 1,
      consolidation_proposals: 1,
      memory_events: 1,
      llm_usage: 1,
    })
  })
})

describe('assertRlsInForce runtime guard', () => {
  it('PASSES against a correctly-provisioned ephemeral DB as the runtime role', async () => {
    // Default expectedRole 'app_user' — runtimePool connects via DATABASE_URL.
    await expect(assertRlsInForce({ db: drizzle(runtimePool) })).resolves.toBeUndefined()
  })

  it('reads the forced-table set from the migrations (single source of truth)', () => {
    const forced = readForcedTenantTables()
    // Every table this suite seeds is part of the forced set parsed from 0028.
    for (const t of SEEDED_FORCED_TABLES) {
      expect(forced, `${t} missing from migration-derived forced set`).toContain(t)
    }
    // 0028 forces twelve tenant-data tables.
    expect(forced.length).toBe(12)
  })

  it('FAILS CLOSED against a bypass-capable / owner connection', async () => {
    // The owner connection is NOT the runtime role (and, being the table owner /
    // often superuser, is exactly the bypass path FORCE + this guard defend
    // against). The guard must reject it rather than certify isolation.
    await expect(assertRlsInForce({ db: drizzle(ownerPool) })).rejects.toBeInstanceOf(RlsGuardError)
  })

  it('FAILS CLOSED when a required table is not actually FORCE-protected', async () => {
    // `users` is a system table with no RLS (relforcerowsecurity=false): pointing
    // the FORCE assertion at it proves the catalog check really fires, not just
    // the role check.
    await expect(
      assertRlsInForce({ db: drizzle(runtimePool), forcedTables: ['users'] }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof RlsGuardError &&
        e.violations.some((v) => v.includes('FORCE ROW LEVEL SECURITY')),
    )
  })
})
