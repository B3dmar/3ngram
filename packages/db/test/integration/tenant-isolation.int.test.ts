// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 1 (docs/concepts/testing.mdx): tenant isolation across EVERY query path —
// memories, edges, facts, commitments, proposals — as the runtime role. Also
// carries the FORCE ROW LEVEL SECURITY behavioral proof and the runtime RLS
// guard tests (src/rls-guard.ts): both belong to the same db-structure suite.

import { type SQL, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, withTenant } from '../../src/client.js'
import { assertRlsInForce, RlsGuardError, readForcedTenantTables } from '../../src/rls-guard.js'
import { closePools, ownerPool, resetDomainTables, runtimePool, seedUser } from './helpers.js'

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

// --- Runtime RLS guard + FORCE ROW LEVEL SECURITY behavioral proof ----------
// Merged from the former rls-guard.int.test.ts so it runs in the already-sharded
// db-structure suite. Proves FORCE isolation as the runtime role and that
// assertRlsInForce() (src/rls-guard.ts) fails closed — replacing the string-match
// proof (migration-drift.test.ts) with an assertion about the LIVE database.
// Model: scripts/ci-smoke-app.sql (unscoped read = 0 rows; A-sees-own/B-sees-nothing).

// Forced tenant-data tables the runtime role (app_user) may SELECT and that
// seedTenantAAllForced seeds, so "B sees 0" is a real cross-tenant probe (not a
// vacuous count over empty tables). The full forced set — including billing
// tables app_user cannot SELECT — is proven at the catalog level by
// assertRlsInForce below.
const SEEDED_FORCED_TABLES = [
  'memories',
  'memory_edges',
  'facts',
  'commitments',
  'consolidation_proposals',
  'fact_proposals',
  'memory_events',
  'llm_usage',
  'agent_sessions',
  'retention_proposals',
] as const

async function seedTenantAAllForced(): Promise<void> {
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
      sql`INSERT INTO fact_proposals (user_id, memory_id, subject, predicate, value, memory_type)
          VALUES (${a}, ${id1}, 's', 'p', 'v', 'fact')`,
    )
    await tx.execute(
      sql`INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind)
          VALUES (${a}, ${id1}, 'create', 'system')`,
    )
    await tx.execute(
      sql`INSERT INTO llm_usage (user_id, operation, model, input_tokens, output_tokens)
          VALUES (${a}, 'memory.embed', 'text-embedding-3-small', 5, 0)`,
    )
    await tx.execute(
      sql`INSERT INTO agent_sessions (user_id, agent, session_id, source, selector)
          VALUES (${a}, 'codex', 'iso-a', 'startup', '{"kind":"all"}'::jsonb)`,
    )
    await tx.execute(
      sql`INSERT INTO retention_proposals (user_id, memory_id, action, probability, probabilities, model)
          VALUES (${a}, ${id1}, 'archive', 0.9, '{"keep":0.1,"archive":0.9}'::jsonb, 'jev-test')`,
    )
  })
}

async function countAllForced(userId: string): Promise<Record<string, number>> {
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
    await seedTenantAAllForced()
    const counts = await countAllForced(b)
    for (const t of SEEDED_FORCED_TABLES) {
      expect(counts[t], `tenant B leaked rows from forced table ${t}`).toBe(0)
    }
  })

  it('tenant A still sees its own rows through the same forced tables (not over-blocked)', async () => {
    await seedTenantAAllForced()
    const counts = await countAllForced(a)
    expect(counts).toEqual({
      memories: 2,
      memory_edges: 1,
      facts: 1,
      commitments: 1,
      consolidation_proposals: 1,
      fact_proposals: 1,
      memory_events: 1,
      llm_usage: 1,
      agent_sessions: 1,
      retention_proposals: 1,
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
    for (const t of SEEDED_FORCED_TABLES) {
      expect(forced, `${t} missing from migration-derived forced set`).toContain(t)
    }
    // 0028 forces twelve tenant-data tables; 0030 adds user_retrieval_policy;
    // 0031 adds fact_proposals; 0032 adds agent_sessions; 0039 adds
    // user_write_scope_policy; 0043 adds user_judgment_policy; 0044 adds
    // resolution_proposals; 0045 adds retention_proposals. The names are
    // asserted individually because a count alone would let a swap (one table
    // gained, another dropped) pass.
    expect(forced.length).toBe(19)
    expect(forced).toContain('user_retrieval_policy')
    expect(forced).toContain('user_write_scope_policy')
    expect(forced).toContain('user_judgment_policy')
    expect(forced).toContain('resolution_proposals')
    expect(forced).toContain('retention_proposals')
    expect(forced).toContain('fact_proposals')
    expect(forced).toContain('agent_sessions')
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

// --- WITH CHECK: cross-tenant INSERT probes (issue #142) ----------------------
// Every proof above is a READ, and a read consults only a policy's USING clause.
// An INSERT consults only WITH CHECK, so a policy whose WITH CHECK diverged from
// USING (say `WITH CHECK (true)`) would pass all of them while letting tenant B
// write rows that carry tenant A's user_id. (An OMITTED WITH CHECK is safe: a
// FOR ALL policy then reuses USING.) Two layers: the catalog check covers every
// policy, the billing tables app_user cannot write included; the probes run the
// rule on every forced table the runtime role can INSERT into.

const rlsRejection = (e: Error) =>
  /row-level security/.test(String((e as { cause?: unknown }).cause ?? e))

interface ProbeTargets {
  m1: string
  m2: string
  run: string
}

/** Tenant A's rows the probes reference, so every foreign key is satisfied. */
async function seedProbeTargets(): Promise<ProbeTargets> {
  return withTenant(a, async (tx) => {
    const m1 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'fact', 'p-1', 'p-1', 'wc1') RETURNING id`,
    )
    const m2 = await tx.execute(
      sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
          VALUES (${a}, 'commitment', 'p-2', 'p-2', 'wc2') RETURNING id`,
    )
    const run = await tx.execute(
      sql`INSERT INTO agent_sessions (user_id, agent, session_id, source, selector)
          VALUES (${a}, 'codex', 'wc-seed', 'startup', '{"kind":"all"}'::jsonb) RETURNING id`,
    )
    return {
      m1: m1.rows[0]?.id as string,
      m2: m2.rows[0]?.id as string,
      run: run.rows[0]?.id as string,
    }
  })
}

/**
 * One row per writable forced table, valid for its owner `u` in every respect
 * but tenancy: foreign keys point at A's rows, so when B sends it with A's
 * user_id, only WITH CHECK can refuse it. The positive control below inserts
 * the same row as A to prove that.
 */
const WITH_CHECK_PROBES: Record<string, (u: string, t: ProbeTargets) => SQL> = {
  agent_sessions: (u) =>
    sql`INSERT INTO agent_sessions (user_id, agent, session_id, source, selector)
        VALUES (${u}, 'codex', 'wc-probe', 'startup', '{"kind":"all"}'::jsonb)`,
  budget_reservations: (u) =>
    sql`INSERT INTO budget_reservations (user_id, estimated_cost_usd) VALUES (${u}, 0.01)`,
  commitments: (u, t) => sql`INSERT INTO commitments (user_id, memory_id) VALUES (${u}, ${t.m2})`,
  consolidation_proposals: (u, t) =>
    sql`INSERT INTO consolidation_proposals (user_id, from_id, to_id, edge_type, memory_type, similarity)
        VALUES (${u}, ${t.m2}, ${t.m1}, 'extends', 'fact', 0.93)`,
  fact_proposals: (u, t) =>
    sql`INSERT INTO fact_proposals (user_id, memory_id, subject, predicate, value, memory_type)
        VALUES (${u}, ${t.m1}, 's', 'p', 'v', 'fact')`,
  facts: (u, t) =>
    sql`INSERT INTO facts (user_id, memory_id, subject, predicate, value)
        VALUES (${u}, ${t.m1}, 's', 'p', 'v')`,
  llm_usage: (u) =>
    sql`INSERT INTO llm_usage (user_id, operation, model, input_tokens, output_tokens)
        VALUES (${u}, 'memory.embed', 'text-embedding-3-small', 5, 0)`,
  memories: (u) =>
    sql`INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
        VALUES (${u}, 'note', 'p-3', 'p-3', 'wc3')`,
  memory_edges: (u, t) =>
    sql`INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
        VALUES (${u}, ${t.m2}, ${t.m1}, 'extends', 'user_api')`,
  memory_events: (u, t) =>
    sql`INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind)
        VALUES (${u}, ${t.m1}, 'create', 'system')`,
  resolution_proposals: (u, t) =>
    sql`INSERT INTO resolution_proposals (user_id, memory_id, session_run_id, probability)
        VALUES (${u}, ${t.m2}, ${t.run}, 0.9)`,
  retention_proposals: (u, t) =>
    sql`INSERT INTO retention_proposals (user_id, memory_id, action, probability, probabilities, model)
        VALUES (${u}, ${t.m1}, 'archive', 0.9, '{"keep":0.1,"archive":0.9}'::jsonb, 'jev-test')`,
  scopes: (u) => sql`INSERT INTO scopes (user_id, name) VALUES (${u}, 'wc-probe')`,
  user_budgets: (u) => sql`INSERT INTO user_budgets (user_id) VALUES (${u})`,
  user_judgment_policy: (u) => sql`INSERT INTO user_judgment_policy (user_id) VALUES (${u})`,
  user_profile_attributes: (u) => sql`INSERT INTO user_profile_attributes (user_id) VALUES (${u})`,
  user_retrieval_policy: (u) => sql`INSERT INTO user_retrieval_policy (user_id) VALUES (${u})`,
  user_write_scope_policy: (u) => sql`INSERT INTO user_write_scope_policy (user_id) VALUES (${u})`,
}

// Per-user tables resetDomainTables leaves in place: it truncates the domain
// tables, and the proposal tables only through their memory foreign keys. The
// positive controls write A's one row into each, so clear both tenants' rows.
const PER_USER_TABLES = [
  'budget_reservations',
  'user_budgets',
  'user_judgment_policy',
  'user_profile_attributes',
  'user_retrieval_policy',
  'user_write_scope_policy',
] as const

describe('WITH CHECK refuses a cross-tenant INSERT (issue #142)', () => {
  beforeEach(async () => {
    for (const t of PER_USER_TABLES) {
      await ownerPool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::uuid[])`, [[a, b]])
    }
  })

  it('probes exactly the forced tables the runtime role can INSERT into', async () => {
    // A forced table added later without a probe fails here, not silently.
    const r = await ownerPool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relforcerowsecurity
          AND has_table_privilege('app_user', c.oid, 'INSERT')
        ORDER BY c.relname`,
    )
    expect(r.rows.map((row) => row.relname)).toEqual(Object.keys(WITH_CHECK_PROBES).sort())
  })

  it.each(Object.keys(WITH_CHECK_PROBES))(
    "%s: B cannot insert a row carrying A's user_id",
    async (table) => {
      const probe = WITH_CHECK_PROBES[table]
      if (probe === undefined) throw new Error(`no probe for ${table}`)
      const targets = await seedProbeTargets()
      await expect(withTenant(b, (tx) => tx.execute(probe(a, targets)))).rejects.toSatisfy(
        rlsRejection,
      )
      // Positive control: the same row is valid for A, so only WITH CHECK refused it.
      await expect(withTenant(a, (tx) => tx.execute(probe(a, targets)))).resolves.toBeDefined()
    },
  )

  it('no policy lets WITH CHECK diverge from USING', async () => {
    // FOR ALL: WITH CHECK must be absent (USING is reused) or identical. An
    // INSERT-only policy has no USING to compare with, so any one is reported
    // for review rather than assumed safe; none exists today.
    const diverged = await ownerPool.query(
      `SELECT tablename, policyname, cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND (cmd = 'INSERT' OR (cmd = 'ALL' AND with_check IS NOT NULL
                                  AND with_check IS DISTINCT FROM qual))`,
    )
    expect(diverged.rows).toEqual([])
    // Not vacuous: every forced table has a FOR ALL policy, so the check above
    // read its WITH CHECK, and that policy is bound to the tenant setting.
    const guarded = await ownerPool.query(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname = 'public' AND cmd = 'ALL'
          AND coalesce(with_check, qual) LIKE '%app.user_id%'`,
    )
    const tables = guarded.rows.map((row) => row.tablename)
    for (const t of readForcedTenantTables()) {
      expect(tables, `forced table ${t} has no tenant-bound FOR ALL policy`).toContain(t)
    }
  })
})
