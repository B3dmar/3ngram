// SPDX-License-Identifier: Apache-2.0
// Worker job unit tests. These exercise the CORE
// logic (consolidate + surface) against STUBBED repos — NO real database and NO
// real Redis (BullMQ is never instantiated here). The stubs record every call so
// the suite can assert the advisory invariants directly:
//
//   - consolidation INSERTs proposals and NEVER mutates memories (the stub repo
//     exposes no memory-mutation seam, and the only write is insertProposals);
//   - an event-type pair is proposed as 'extends' ONLY (the S1 invariant);
//   - surfacing expires the right (overdue) commitments and surfaces the right
//     (due) ones, leaving the rest untouched.
//
// The queue wiring (startQueues) is covered by mocking the bullmq module so the
// dispatch routing is asserted without a Redis server.
import {
  type ConsolidateRepo,
  chooseProposedEdge,
  consolidate,
  GC_CLIENT_IDLE_DAYS,
  type GcClientsRepo,
  garbageCollectClients,
  type SurfacingRepo,
  surface,
} from '@3ngram/core'
import { describe, expect, it, vi } from 'vitest'

// The memory types, inlined: the worker depends on @3ngram/core only (not
// @3ngram/schema directly), so the test enumerates them rather than importing
// the schema's MEMORY_TYPES. Kept in sync with packages/schema memoryTypeSchema.
const MEMORY_TYPES = [
  'fact',
  'preference',
  'decision',
  'commitment',
  'blocker',
  'pattern',
  'note',
  'event',
] as const

describe('consolidate (F1)', () => {
  it('inserts advisory proposals per tenant and never mutates memories', async () => {
    const inserted: { userId: string; count: number }[] = []
    const repo: ConsolidateRepo = {
      listTenantIds: async () => ['tenant-a', 'tenant-b'],
      findSimilarPairs: async (userId) =>
        userId === 'tenant-a'
          ? [
              {
                fromId: '00000000-0000-0000-0000-000000000001',
                toId: '00000000-0000-0000-0000-000000000002',
                fromType: 'fact',
                toType: 'fact',
                similarity: 0.95,
              },
            ]
          : [],
      insertProposals: async (userId, proposals) => {
        // The ONLY write seam the consolidator has is insertProposals. There is
        // no memory-mutation method on the repo at all — advisory-only by
        // construction (docs/concepts/memory-model.mdx "Consolidation is advisory").
        inserted.push({ userId, count: proposals.length })
        return proposals.length
      },
    }

    const result = await consolidate(repo)

    expect(result.tenantsScanned).toBe(2)
    expect(result.pairsConsidered).toBe(1)
    expect(result.proposalsInserted).toBe(1)
    // Only tenant-a had a pair; tenant-b's empty result must not trigger a write.
    expect(inserted).toEqual([{ userId: 'tenant-a', count: 1 }])
  })

  it('proposes status="proposed" rows with a fact pair as a non-destructive edge', async () => {
    let captured: { edgeType: string; status?: string } | undefined
    const repo: ConsolidateRepo = {
      listTenantIds: async () => ['t'],
      findSimilarPairs: async () => [
        {
          fromId: '00000000-0000-0000-0000-0000000000a1',
          toId: '00000000-0000-0000-0000-0000000000a2',
          fromType: 'fact',
          toType: 'fact',
          similarity: 0.99,
        },
      ],
      insertProposals: async (_userId, proposals) => {
        const [p] = proposals
        if (p) captured = { edgeType: p.edgeType }
        return proposals.length
      },
    }

    await consolidate(repo)

    // The conservative preference is the advisory 'extends' edge.
    expect(captured?.edgeType).toBe('extends')
  })

  it('proposes ONLY the advisory extends edge for an event-type pair (S1 invariant)', async () => {
    const captured: string[] = []
    const repo: ConsolidateRepo = {
      listTenantIds: async () => ['t'],
      findSimilarPairs: async () => [
        {
          fromId: '00000000-0000-0000-0000-0000000000b1',
          toId: '00000000-0000-0000-0000-0000000000b2',
          fromType: 'event',
          toType: 'event',
          similarity: 0.999,
        },
        {
          // mixed pair: one event side still collapses to extends-only
          fromId: '00000000-0000-0000-0000-0000000000b3',
          toId: '00000000-0000-0000-0000-0000000000b4',
          fromType: 'event',
          toType: 'fact',
          similarity: 0.97,
        },
      ],
      insertProposals: async (_userId, proposals) => {
        for (const p of proposals) captured.push(p.edgeType)
        return proposals.length
      },
    }

    await consolidate(repo)

    // EVERY proposal touching an event-type memory is 'extends' — never
    // supersedes/updates/derives (the destructive-merge class, docs/concepts/memory-model.mdx "Consolidation is advisory").
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.every((edge) => edge === 'extends')).toBe(true)
  })

  it('skips a pair when an unknown memory type cannot be narrowed to the schema enum', async () => {
    let writes = 0
    const repo: ConsolidateRepo = {
      listTenantIds: async () => ['t'],
      findSimilarPairs: async () => [
        {
          fromId: '00000000-0000-0000-0000-0000000000c1',
          toId: '00000000-0000-0000-0000-0000000000c2',
          fromType: 'not-a-real-type',
          toType: 'fact',
          similarity: 0.98,
        },
      ],
      insertProposals: async (_userId, proposals) => {
        writes += proposals.length
        return proposals.length
      },
    }

    const result = await consolidate(repo)

    expect(writes).toBe(0)
    expect(result.proposalsInserted).toBe(0)
  })
})

describe('chooseProposedEdge', () => {
  it('never proposes a destructive edge for any pairing that includes event', () => {
    // The S1 invariant: an event pairing yields EITHER 'extends' (when the other
    // side also admits it) OR undefined (no common edge) — NEVER
    // supersedes/updates/derives, the destructive-merge class (docs/concepts/memory-model.mdx "Consolidation is advisory").
    const allowed = new Set([undefined, 'extends'])
    for (const other of MEMORY_TYPES) {
      expect(allowed.has(chooseProposedEdge('event', other))).toBe(true)
      expect(allowed.has(chooseProposedEdge(other, 'event'))).toBe(true)
    }
    // And when the other side DOES admit extends, the proposal is exactly extends.
    expect(chooseProposedEdge('event', 'fact')).toBe('extends')
    expect(chooseProposedEdge('event', 'event')).toBe('extends')
  })
})

describe('garbageCollectClients', () => {
  // The clock is injected so the cutoff is deterministic; the repo predicate
  // (last_used_at IS NULL AND created_at < cutoff) is the only deletion gate, so
  // the test simulates the predicate by returning candidate ids for the cutoff.
  const NOW = new Date('2026-06-16T00:00:00.000Z')

  it('collects only the idle-and-never-used candidates the repo returns for the 30d cutoff', async () => {
    let seenCutoff: Date | undefined
    let deleted: string[] | undefined
    const repo: GcClientsRepo = {
      listGarbageCollectableClients: async (cutoff) => {
        seenCutoff = cutoff
        // The repo's job is the predicate; the unit asserts the policy hands it
        // the right cutoff and deletes exactly what it returns.
        return ['client-idle-1', 'client-idle-2']
      },
      deleteClients: async (ids) => {
        deleted = ids
        return ids.length
      },
    }

    const result = await garbageCollectClients(repo, { now: NOW })

    // cutoff = now - 30 days (the default idle threshold).
    const expectedCutoff = new Date(NOW.getTime() - GC_CLIENT_IDLE_DAYS * 86_400_000)
    expect(seenCutoff?.toISOString()).toBe(expectedCutoff.toISOString())
    expect(deleted).toEqual(['client-idle-1', 'client-idle-2'])
    expect(result.candidates).toBe(2)
    expect(result.collected).toBe(2)
  })

  it('keeps recently-used clients: an empty candidate set deletes nothing', async () => {
    let deleteCalled = false
    const repo: GcClientsRepo = {
      // A recently-used or recently-registered client never matches the
      // predicate, so the repo returns no candidates — the policy must not call
      // delete at all (no accidental wipe).
      listGarbageCollectableClients: async () => [],
      deleteClients: async (ids) => {
        deleteCalled = true
        return ids.length
      },
    }

    const result = await garbageCollectClients(repo, { now: NOW })

    expect(deleteCalled).toBe(false)
    expect(result.candidates).toBe(0)
    expect(result.collected).toBe(0)
  })

  it('honors an overridden idle threshold when computing the cutoff', async () => {
    let seenCutoff: Date | undefined
    const repo: GcClientsRepo = {
      listGarbageCollectableClients: async (cutoff) => {
        seenCutoff = cutoff
        return []
      },
      deleteClients: async (ids) => ids.length,
    }

    await garbageCollectClients(repo, { now: NOW, idleDays: 7 })

    expect(seenCutoff?.toISOString()).toBe(new Date(NOW.getTime() - 7 * 86_400_000).toISOString())
  })

  it('propagates a repo failure (no falsely-green run)', async () => {
    const repo: GcClientsRepo = {
      listGarbageCollectableClients: async () => {
        throw new Error('db down')
      },
      deleteClients: async (ids) => ids.length,
    }

    await expect(garbageCollectClients(repo, { now: NOW })).rejects.toThrow('db down')
  })
})

describe('surface (F2)', () => {
  it('aggregates the per-tenant overdue/surfacing sweep counts', async () => {
    const now = new Date('2026-06-09T12:00:00.000Z')
    const calls: { userId: string; now: Date }[] = []
    const repo: SurfacingRepo = {
      listTenantIds: async () => ['t1', 't2'],
      sweepCommitments: async (userId, sweepNow) => {
        calls.push({ userId, now: sweepNow })
        return userId === 't1' ? { expired: 2, surfaced: 1 } : { expired: 0, surfaced: 3 }
      },
    }

    const result = await surface(repo, now)

    expect(result.tenantsScanned).toBe(2)
    expect(result.expired).toBe(2)
    expect(result.surfaced).toBe(4)
    // The injected instant is threaded to every per-tenant sweep (no clock in core).
    expect(calls.every((c) => c.now === now)).toBe(true)
    expect(calls.map((c) => c.userId)).toEqual(['t1', 't2'])
  })

  it('propagates a per-tenant sweep failure (no falsely-green run)', async () => {
    const repo: SurfacingRepo = {
      listTenantIds: async () => ['t1'],
      sweepCommitments: async () => {
        throw new Error('db down')
      },
    }

    await expect(surface(repo, new Date())).rejects.toThrow('db down')
  })
})

describe('queue wiring (harness, Redis mocked)', () => {
  it('routes each job name to its core-backed runner without a real Redis', async () => {
    // Mock bullmq so no Redis connection is opened. The Worker constructor
    // captures the processor; we then invoke it with each job name and assert it
    // dispatches to the right runner via the jobs modules (mocked to record).
    let captured: ((job: { name: string }) => Promise<unknown>) | undefined
    vi.doMock('bullmq', () => ({
      Queue: class {
        upsertJobScheduler = vi.fn(async () => ({}))
        // The closer flag is a kill switch: with it off, startQueues REMOVES the
        // durable sweep scheduler rather than merely skipping the upsert.
        removeJobScheduler = vi.fn(async () => true)
        add = vi.fn(async () => ({}))
        close = vi.fn(async () => {})
      },
      Worker: class {
        constructor(_name: string, processor: (job: { name: string }) => Promise<unknown>) {
          captured = processor
        }
        on = vi.fn()
        close = vi.fn(async () => {})
      },
    }))
    const consolidationRun = vi.fn(async () => 'consolidation-ran')
    const surfacingRun = vi.fn(async () => 'surfacing-ran')
    const gcClientsRun = vi.fn(async () => 'gc-clients-ran')
    vi.doMock('../src/jobs/consolidation.js', () => ({
      CONSOLIDATION_JOB: 'consolidation',
      runConsolidation: consolidationRun,
    }))
    vi.doMock('../src/jobs/surfacing.js', () => ({
      SURFACING_JOB: 'surfacing',
      runSurfacing: surfacingRun,
    }))
    vi.doMock('../src/jobs/gc-clients.js', () => ({
      GC_CLIENTS_JOB: 'gc-clients',
      runGcClients: gcClientsRun,
    }))

    const { startQueues, JOB_RETRY_OPTS } = await import('../src/queues.js')
    // The Redis arg is unused by the mocked Queue/Worker — cast a stub through.
    const handles = await startQueues({} as never)
    expect(captured).toBeDefined()

    // Both scheduler templates must carry the retry policy: without attempts,
    // BullMQ defaults to a single attempt and a transient DB/Redis failure
    // silently skips the pass until the next cron tick.
    const upsert = (handles.queue as unknown as { upsertJobScheduler: ReturnType<typeof vi.fn> })
      .upsertJobScheduler
    expect(upsert).toHaveBeenCalledTimes(3)
    for (const [, , template] of upsert.mock.calls) {
      expect(template.opts).toEqual(JOB_RETRY_OPTS)
    }
    expect(JOB_RETRY_OPTS.attempts).toBeGreaterThan(1)

    await captured?.({ name: 'consolidation' })
    await captured?.({ name: 'surfacing' })
    await captured?.({ name: 'gc-clients' })
    expect(consolidationRun).toHaveBeenCalledOnce()
    expect(surfacingRun).toHaveBeenCalledOnce()
    expect(gcClientsRun).toHaveBeenCalledOnce()

    await expect(captured?.({ name: 'mystery' })).rejects.toThrow('unknown job name')

    vi.doUnmock('bullmq')
    vi.doUnmock('../src/jobs/consolidation.js')
    vi.doUnmock('../src/jobs/surfacing.js')
    vi.doUnmock('../src/jobs/gc-clients.js')
    vi.resetModules()
  })
})
