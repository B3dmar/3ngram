// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. reviseDisposition() (issue #217): one parse at the
// boundary, the access gate and the run-id ownership check BEFORE any id is
// touched, then one db call per id in request order, each outcome reported as
// the db layer decided it (one rejection never fails the batch).
import { afterEach, describe, expect, it, vi } from 'vitest'

const archiveMemoryDisposition = vi.fn()
const reaffirmMemoryDisposition = vi.fn()
const assertSessionRunOwned = vi.fn()
vi.mock('@3ngram/db', () => ({
  archiveMemoryDisposition: (...a: unknown[]) => archiveMemoryDisposition(...a),
  reaffirmMemoryDisposition: (...a: unknown[]) => reaffirmMemoryDisposition(...a),
  assertSessionRunOwned: (...a: unknown[]) => assertSessionRunOwned(...a),
}))

const { reviseDisposition } = await import('../src/write/revise-disposition.js')

const USER = '00000000-0000-7000-8000-000000000001'
const A = '00000000-0000-7000-8000-0000000000aa'
const B = '00000000-0000-7000-8000-0000000000bb'
const C = '00000000-0000-7000-8000-0000000000cc'
const RUN = '01890b6e-0000-7000-8000-0000000000dd'

afterEach(() => {
  archiveMemoryDisposition.mockReset()
  reaffirmMemoryDisposition.mockReset()
  assertSessionRunOwned.mockReset()
})

describe('reviseDisposition archive (#217)', () => {
  it('walks the batch in order, one db call per id, and reports each outcome', async () => {
    archiveMemoryDisposition
      .mockResolvedValueOnce({ memoryId: A, outcome: 'archived' })
      .mockResolvedValueOnce({ memoryId: B, outcome: 'rejected', reason: 'blocker' })
      .mockResolvedValueOnce({ memoryId: C, outcome: 'already_archived' })

    const result = await reviseDisposition(
      USER,
      { kind: 'archive', memoryIds: [A, B, C] },
      'user_mcp',
    )

    expect(result).toEqual({
      kind: 'archive',
      outcomes: [
        { memoryId: A, outcome: 'archived' },
        { memoryId: B, outcome: 'rejected', reason: 'blocker' },
        { memoryId: C, outcome: 'already_archived' },
      ],
    })
    expect(archiveMemoryDisposition.mock.calls.map(([input]) => input.memoryId)).toEqual([A, B, C])
    expect(archiveMemoryDisposition.mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      actorKind: 'user_mcp',
    })
    expect(assertSessionRunOwned).not.toHaveBeenCalled()
  })

  it('checks a supplied run id once, up front, and threads it to every id', async () => {
    archiveMemoryDisposition.mockResolvedValue({ memoryId: A, outcome: 'archived' })

    await reviseDisposition(
      USER,
      { kind: 'archive', memoryIds: [A, B], sessionRunId: RUN },
      'user_api',
    )

    expect(assertSessionRunOwned.mock.calls).toEqual([[USER, RUN]])
    for (const [input] of archiveMemoryDisposition.mock.calls) {
      expect(input.sessionRunId).toBe(RUN)
    }
  })

  it('an unowned run id fails the whole call before any id is touched', async () => {
    const unowned = new Error('session run is not owned by this tenant')
    assertSessionRunOwned.mockRejectedValue(unowned)

    await expect(
      reviseDisposition(USER, { kind: 'archive', memoryIds: [A], sessionRunId: RUN }, 'user_api'),
    ).rejects.toBe(unowned)
    expect(archiveMemoryDisposition).not.toHaveBeenCalled()
  })

  it('a denied access gate fails before any id is touched', async () => {
    const denied = new Error('denied')
    const access = { assertWrite: vi.fn().mockRejectedValue(denied), assertRead: vi.fn() }

    await expect(
      reviseDisposition(USER, { kind: 'archive', memoryIds: [A] }, 'user_api', {
        access: access as never,
      }),
    ).rejects.toBe(denied)
    expect(access.assertWrite).toHaveBeenCalledWith(USER)
    expect(archiveMemoryDisposition).not.toHaveBeenCalled()
  })

  it('validates once at the boundary: a malformed batch never reaches the db', async () => {
    for (const input of [
      { kind: 'archive', memoryIds: [] },
      { kind: 'archive', memoryIds: [A, A] },
      { kind: 'archive', predecessorId: A },
    ]) {
      await expect(reviseDisposition(USER, input, 'user_api')).rejects.toThrow()
    }
    expect(archiveMemoryDisposition).not.toHaveBeenCalled()
  })
})

describe('reviseDisposition reaffirm (#218)', () => {
  it('routes each id to the reaffirm write, never the archive one', async () => {
    reaffirmMemoryDisposition
      .mockResolvedValueOnce({ memoryId: A, outcome: 'reaffirmed' })
      .mockResolvedValueOnce({ memoryId: B, outcome: 'rejected', reason: 'archived' })

    const result = await reviseDisposition(
      USER,
      { kind: 'reaffirm', memoryIds: [A, B] },
      'user_mcp',
    )

    expect(result).toEqual({
      kind: 'reaffirm',
      outcomes: [
        { memoryId: A, outcome: 'reaffirmed' },
        { memoryId: B, outcome: 'rejected', reason: 'archived' },
      ],
    })
    expect(reaffirmMemoryDisposition.mock.calls.map(([input]) => input.memoryId)).toEqual([A, B])
    expect(archiveMemoryDisposition).not.toHaveBeenCalled()
  })
})
