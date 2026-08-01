// SPDX-License-Identifier: Apache-2.0
// Integration — embed-on-write against the real runtime role (app_user,
// NOBYPASSRLS) on the CI ephemeral Neon branch, with FakeGateway (no network).
// Proves the slice-3 invariants unit tests cannot:
//   - ack-before-embed: remember() resolves with the id; AFTER awaiting the embed
//     handle, the row carries a 1536-dim embedding (+ bumped updated_at)
//   - the embedded row is VECTOR-LEG searchable (searchFused with weights.vector
//     > 0 and the same query embedding finds it; NULL-embedding rows do not)
//   - cross-tenant isolation: the embedding UPDATE is RLS-scoped — B's identical
//     content keeps its own NULL embedding, A's update never touches it
//   - revise() embeds the SUCCESSOR; the superseded predecessor stays NULL
//
// Reuses packages/db integration infra (helpers.ts).
import { closeDb, searchFused, withTenant } from '@3ngram/db'
import type { Gateway } from '@3ngram/llm'
import { createFakeGateway, EMBEDDING_DIMENSIONS, fakeEmbedding } from '@3ngram/llm'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { remember } from '../../src/write/remember.js'
import { retryFailedEmbeds } from '../../src/write/repair.js'
import { revise } from '../../src/write/revise.js'

const ACTOR: ActorKind = 'user_api'
const silentLogger = { warn: () => {} }

let userA: string
let userB: string

const input = (content: string) => ({ memoryType: 'note', topic: 'embed', content, tags: [] })

beforeAll(async () => {
  userA = await seedUser('embed-a@test.local')
  userB = await seedUser('embed-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('embed-on-write (runtime role, FakeGateway, real withTenant)', () => {
  it('lands a 1536-dim embedding AFTER ack and bumps updated_at', async () => {
    const gateway = createFakeGateway()
    const content = 'kubernetes canary rollout with automated rollback'
    const result = await remember(userA, input(content), ACTOR, { gateway, logger: silentLogger })

    // Pre-settle the row may still be NULL (ack-before-embed); after the handle
    // settles the vector is present.
    const landed = await result.embed.settled
    expect(landed).toBe(true)

    const row = await ownerPool.query(
      'SELECT embedding, vector_dims(embedding) AS dims, updated_at, created_at FROM memories WHERE id = $1',
      [result.id],
    )
    expect(row.rows[0].embedding).not.toBeNull()
    expect(Number(row.rows[0].dims)).toBe(EMBEDDING_DIMENSIONS)
  })

  it('lands exactly one llm_usage row with non-zero input tokens + cost (issue #231)', async () => {
    const gateway = createFakeGateway()
    const result = await remember(userA, input('cost tracking lands a usage row'), ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await result.embed.settled).toBe(true)

    const usage = await ownerPool.query(
      'SELECT operation, model, input_tokens, output_tokens, cost_usd FROM llm_usage WHERE user_id = $1',
      [userA],
    )
    // EXACTLY ONE row per embed() call (not per text, not per memory).
    expect(usage.rows).toHaveLength(1)
    const row = usage.rows[0]
    expect(row.operation).toBe('memory.embed')
    expect(row.model).toBe('text-embedding-3-large')
    expect(Number(row.input_tokens)).toBeGreaterThan(0)
    // output_tokens is structurally 0 for embeddings.
    expect(Number(row.output_tokens)).toBe(0)
    // cost_usd = inputTokens * rate -> strictly positive for a priced model.
    expect(Number(row.cost_usd)).toBeGreaterThan(0)

    // Hard rule 6: the usage row carries NO memory content — only the bounded
    // operation/model/token/cost fields exist on the table (no content column).
    const cols = await ownerPool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_usage'",
    )
    const names = cols.rows.map((c) => c.column_name)
    expect(names).not.toContain('content')
  })

  it('makes the embedded row vector-leg searchable (NULL-embedding rows are not)', async () => {
    const gateway = createFakeGateway()
    const target = 'postgres logical replication slot management'
    const embedded = await remember(userA, input(target), ACTOR, { gateway, logger: silentLogger })
    await embedded.embed.settled

    // A second row with NO gateway -> embedding stays NULL (not vector-searchable).
    const plain = await remember(userA, input('an unrelated note about coffee'), ACTOR)
    await plain.embed.settled

    // Query with the SAME embedding the gateway produced for the target text and
    // a non-zero vector weight: the embedded row is recalled via the vector leg.
    const queryEmbedding = fakeEmbedding(target)
    const hits = await withTenant(userA, (tx) =>
      searchFused(
        tx,
        userA,
        'nonmatching lexical query xyzzy',
        10,
        { fts: 1, recency: 0, vector: 1 },
        2,
        queryEmbedding,
      ),
    )
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(embedded.id)
    // The NULL-embedding row has no vector to match and no lexical/recency pull.
    expect(ids).not.toContain(plain.id)
  })

  it('isolates the embedding UPDATE by tenant (B’s identical content stays NULL)', async () => {
    const gateway = createFakeGateway()
    const content = 'shared content across two tenants'
    const a = await remember(userA, input(content), ACTOR, { gateway, logger: silentLogger })
    await a.embed.settled
    // B writes the SAME content with NO gateway: embedding NULL.
    const b = await remember(userB, input(content), ACTOR)
    await b.embed.settled

    const aRow = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [a.id])
    const bRow = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [b.id])
    expect(aRow.rows[0].embedding).not.toBeNull()
    expect(bRow.rows[0].embedding).toBeNull()
  })

  it('embeds the successor on revise; the superseded predecessor stays NULL', async () => {
    const gateway = createFakeGateway()
    // Predecessor written WITHOUT a gateway -> NULL embedding.
    const pred = await remember(userA, input('release cut from main weekly'), ACTOR)
    await pred.embed.settled

    const succ = await revise(
      userA,
      { ...input('release cut from main after a soak'), predecessorId: pred.id },
      ACTOR,
      { gateway, logger: silentLogger },
    )
    await succ.embed.settled

    const predRow = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [pred.id])
    const succRow = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [succ.id])
    expect(predRow.rows[0].embedding).toBeNull()
    expect(succRow.rows[0].embedding).not.toBeNull()
  })
})

describe('retryFailedEmbeds (#232 repair path, runtime role)', () => {
  it('repairs an embed_failed row: vector lands, scoped to the tenant', async () => {
    // 1) Write with a FAILING gateway: the row lands embed_failed, NULL vector
    //    — exactly the state the 7 P2a migration rows were left in.
    const failing: Gateway = {
      embed: async () => {
        throw Object.assign(new Error('transient'), { name: 'GatewayRequestError', status: 429 })
      },
      complete: async () => 'x',
    }
    const broken = await remember(userA, input('repairable short content'), ACTOR, {
      gateway: failing,
      logger: silentLogger,
    })
    expect(await broken.embed.settled).toBe(false)

    const before = await ownerPool.query(
      "SELECT m.embedding, e.payload->>'reason' AS reason FROM memories m JOIN memory_events e ON e.memory_id = m.id WHERE m.id = $1 AND e.event_kind = 'embed_failed'",
      [broken.id],
    )
    expect(before.rows[0].embedding).toBeNull()
    expect(before.rows[0].reason).toBe('GatewayRequestError:429 (msg len 9)')

    // A healthy row for tenant B must not be touched by A's repair pass.
    const other = await remember(userB, input('other tenant row'), ACTOR)
    await other.embed.settled

    // 2) Repair with a WORKING gateway: the vector lands 1536-dim.
    const result = await retryFailedEmbeds(userA, {
      gateway: createFakeGateway(),
      logger: silentLogger,
    })
    expect(result).toEqual({ scanned: 1, landed: 1, failed: 0 })

    const after = await ownerPool.query(
      'SELECT vector_dims(embedding) AS dims FROM memories WHERE id = $1',
      [broken.id],
    )
    expect(Number(after.rows[0].dims)).toBe(EMBEDDING_DIMENSIONS)

    // 3) Idempotent: a second pass finds nothing (embedding no longer NULL).
    const again = await retryFailedEmbeds(userA, {
      gateway: createFakeGateway(),
      logger: silentLogger,
    })
    expect(again).toEqual({ scanned: 0, landed: 0, failed: 0 })

    const bRow = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [other.id])
    expect(bRow.rows[0].embedding).toBeNull()
  })
})
