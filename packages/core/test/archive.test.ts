// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. archiveMemory() is a thin orchestration over the db status
// flip; the ONE policy under test is the error contract: the db layer's
// ActiveMemoryNotFoundError is re-keyed to core's MemoryNotFoundError (the REST
// mapper's existing 404 branch), any other error passes through untouched.
// Real-Postgres coverage (row invariant, audit event, RLS) lives in
// apps/server/test/integration/rest.int.test.ts through the REST transport.
import { afterEach, describe, expect, it, vi } from 'vitest'

const dbArchiveMemory = vi.fn()

vi.mock('@3ngram/db', () => ({
  archiveMemory: (...a: unknown[]) => dbArchiveMemory(...a),
  ActiveMemoryNotFoundError: class ActiveMemoryNotFoundError extends Error {
    readonly memoryId: string
    constructor(memoryId: string) {
      super('no active memory found for this tenant')
      this.name = 'ActiveMemoryNotFoundError'
      this.memoryId = memoryId
    }
  },
}))

const { ActiveMemoryNotFoundError } = await import('@3ngram/db')
const { archiveMemory } = await import('../src/write/archive.js')
const { MemoryNotFoundError } = await import('../src/read/memory.js')

const USER = '00000000-0000-7000-8000-000000000001'
const MEMORY = '00000000-0000-7000-8000-0000000000aa'
const ACTOR = 'user_api' as const

afterEach(() => {
  dbArchiveMemory.mockReset()
})

describe('archiveMemory', () => {
  it('forwards userId, memoryId, and actor to the db helper and echoes its result', async () => {
    dbArchiveMemory.mockResolvedValue({ id: MEMORY, status: 'archived' })

    const result = await archiveMemory(USER, MEMORY, ACTOR)

    expect(result).toEqual({ id: MEMORY, status: 'archived' })
    expect(dbArchiveMemory.mock.calls[0]).toEqual([USER, MEMORY, ACTOR, undefined])
  })

  it('maps the db typed miss (ActiveMemoryNotFoundError) to MemoryNotFoundError', async () => {
    dbArchiveMemory.mockRejectedValue(new ActiveMemoryNotFoundError(MEMORY))

    await expect(archiveMemory(USER, MEMORY, ACTOR)).rejects.toBeInstanceOf(MemoryNotFoundError)
    await expect(archiveMemory(USER, MEMORY, ACTOR)).rejects.toMatchObject({ memoryId: MEMORY })
  })

  it('passes any OTHER error through untouched (no blanket 404 masking)', async () => {
    const boom = new Error('connection reset')
    dbArchiveMemory.mockRejectedValue(boom)

    await expect(archiveMemory(USER, MEMORY, ACTOR)).rejects.toBe(boom)
  })
})
