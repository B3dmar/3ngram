// SPDX-License-Identifier: Apache-2.0
// Lease-expiry sweep policy: no database, no Redis.
//
// The sweep is the PRODUCER the crash path lacks, so what matters is the
// fan-out shape (one pre-tenant enumeration, then per-tenant work), that every
// closed-and-untriaged run reaches the queue exactly once per pass, and that a
// per-tenant failure is NOT swallowed into a falsely-green run.
import { describe, expect, it } from 'vitest'
import {
  type CloserEnqueueRequest,
  type SessionSweepRepo,
  sweepSessions,
} from '../src/admin/session-sweep.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')

function fakeRepo(overrides: Partial<SessionSweepRepo> = {}): SessionSweepRepo & {
  enqueued: CloserEnqueueRequest[]
} {
  const enqueued: CloserEnqueueRequest[] = []
  const base: SessionSweepRepo = {
    listTenantIds: async () => ['tenant-a'],
    sweepExpiredLeases: async () => [{ sessionRunId: 'run-1', activationEpoch: 1 }],
    listCloserCandidates: async () => [{ sessionRunId: 'run-1', activationEpoch: 1 }],
    expireStaleExcerpts: async () => 0,
    enqueueCloser: async (request) => {
      enqueued.push(request)
    },
  }
  return { ...base, ...overrides, enqueued } as SessionSweepRepo & {
    enqueued: CloserEnqueueRequest[]
  }
}

describe('sweepSessions', () => {
  it('enqueues a swept run ONCE, not once per producer', async () => {
    // The sweep closes the row and then lists candidates, which now includes it.
    // Enqueueing from both legs would double the LLM spend for one run.
    const repo = fakeRepo()
    const result = await sweepSessions(repo, NOW)

    expect(repo.enqueued).toEqual([
      { userId: 'tenant-a', sessionRunId: 'run-1', activationEpoch: 1 },
    ])
    expect(result).toMatchObject({ tenantsScanned: 1, implicitlyClosed: 1, enqueued: 1 })
  })

  it('enqueues an EXPLICITLY closed run the sweep never touched', async () => {
    // SessionEnd closed it, so the lease leg finds nothing — but its triage
    // never ran, so the closer must still see it. That is the second producer.
    const repo = fakeRepo({
      sweepExpiredLeases: async () => [],
      listCloserCandidates: async () => [{ sessionRunId: 'run-explicit', activationEpoch: 7 }],
    })
    const result = await sweepSessions(repo, NOW)

    expect(result.implicitlyClosed).toBe(0)
    expect(repo.enqueued).toEqual([
      { userId: 'tenant-a', sessionRunId: 'run-explicit', activationEpoch: 7 },
    ])
  })

  it('carries the epoch observed at sweep time, so the closer can fence on it', async () => {
    const repo = fakeRepo({
      listCloserCandidates: async () => [{ sessionRunId: 'run-1', activationEpoch: 42 }],
    })
    await sweepSessions(repo, NOW)
    expect(repo.enqueued[0]?.activationEpoch).toBe(42)
  })

  it('fans out per tenant off ONE pre-tenant enumeration', async () => {
    const scanned: string[] = []
    const repo = fakeRepo({
      listTenantIds: async () => ['a', 'b', 'c'],
      sweepExpiredLeases: async (userId) => {
        scanned.push(userId)
        return []
      },
      listCloserCandidates: async () => [],
    })
    const result = await sweepSessions(repo, NOW)

    expect(scanned).toEqual(['a', 'b', 'c'])
    expect(result.tenantsScanned).toBe(3)
  })

  it('passes the configured batch bound down to the per-tenant query', async () => {
    const limits: number[] = []
    const repo = fakeRepo({
      sweepExpiredLeases: async (_userId, _now, limit) => {
        limits.push(limit)
        return []
      },
      listCloserCandidates: async (_userId, limit) => {
        limits.push(limit)
        return []
      },
    })
    await sweepSessions(repo, NOW, { limitPerTenant: 5 })
    expect(limits).toEqual([5, 5])
  })

  it('expires excerpts against a TTL floor derived from the injected clock', async () => {
    let floor: Date | undefined
    let ttlLimit: number | undefined
    const repo = fakeRepo({
      listCloserCandidates: async () => [],
      expireStaleExcerpts: async (_userId, before, limit) => {
        floor = before
        ttlLimit = limit
        return 2
      },
    })
    const result = await sweepSessions(repo, NOW, { limitPerTenant: 7 })

    expect(floor).toBeDefined()
    // Strictly in the past — core reads no clock of its own, so a wrong sign
    // here would clear every excerpt in the tenant on the first pass.
    expect((floor as Date).getTime()).toBeLessThan(NOW.getTime())
    // Bounded like the other two legs: an unbounded UPDATE over a big backlog
    // would hold row locks far past the advertised per-tenant batch.
    expect(ttlLimit).toBe(7)
    expect(result.excerptsExpired).toBe(2)
  })

  it('propagates a per-tenant failure instead of reporting a green pass', async () => {
    const repo = fakeRepo({
      listTenantIds: async () => ['a', 'b'],
      sweepExpiredLeases: async (userId) => {
        if (userId === 'b') throw new Error('deadlock')
        return []
      },
    })
    await expect(sweepSessions(repo, NOW)).rejects.toThrow('deadlock')
  })
})
