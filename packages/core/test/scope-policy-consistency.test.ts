// SPDX-License-Identifier: Apache-2.0
// Scope-registry mutations keep the denormalized retrieval default coherent.
import { afterEach, describe, expect, it, vi } from 'vitest'

const tx = { kind: 'tenant-tx' }
const withTenant = vi.fn(async (_userId: string, fn: (value: unknown) => Promise<unknown>) =>
  fn(tx),
)
const lockRetrievalScopePolicy = vi.fn(async (_tx: unknown, _userId: string) => undefined)
const renameScopeDb = vi.fn(
  async (_tx: unknown, _userId: string, _oldName: string, _newName: string): Promise<unknown> =>
    undefined,
)
const deleteScopeDb = vi.fn(async (_tx: unknown, _userId: string, _name: string) => undefined)
const replaceRetrievalPolicyDefault = vi.fn(
  async (
    _tx: unknown,
    _userId: string,
    _oldDefault: string,
    _policy: { mode: 'default' | 'require'; defaultScope: string | null },
  ) => undefined,
)

vi.mock('@3ngram/db', () => ({
  withTenant: (userId: string, fn: (value: unknown) => Promise<unknown>) => withTenant(userId, fn),
  lockRetrievalScopePolicy: (tx: unknown, userId: string) => lockRetrievalScopePolicy(tx, userId),
  renameScope: (tx: unknown, userId: string, oldName: string, newName: string) =>
    renameScopeDb(tx, userId, oldName, newName),
  deleteScope: (tx: unknown, userId: string, name: string) => deleteScopeDb(tx, userId, name),
  replaceRetrievalPolicyDefault: (
    tx: unknown,
    userId: string,
    oldDefault: string,
    policy: { mode: 'default' | 'require'; defaultScope: string | null },
  ) => replaceRetrievalPolicyDefault(tx, userId, oldDefault, policy),
}))

const { deleteScope, renameScope } = await import('../src/scope/scopes.js')

const USER = 'user-1'
const SCOPE = {
  id: 'scope-1',
  name: 'client',
  aliases: [],
  createdAt: new Date('2026-08-04T12:00:00.000Z'),
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('scope and retrieval-policy consistency', () => {
  it('renames an active default in the same locked transaction', async () => {
    renameScopeDb.mockResolvedValue(SCOPE)

    await expect(renameScope(USER, 'work', 'client')).resolves.toEqual(SCOPE)

    expect(lockRetrievalScopePolicy).toHaveBeenCalledWith(tx, USER)
    expect(renameScopeDb).toHaveBeenCalledWith(tx, USER, 'work', 'client')
    expect(replaceRetrievalPolicyDefault).toHaveBeenCalledWith(tx, USER, 'work', {
      mode: 'default',
      defaultScope: 'client',
    })
    expect(lockRetrievalScopePolicy.mock.invocationCallOrder[0]).toBeLessThan(
      renameScopeDb.mock.invocationCallOrder[0] ?? 0,
    )
    expect(renameScopeDb.mock.invocationCallOrder[0]).toBeLessThan(
      replaceRetrievalPolicyDefault.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('moves a deleted active default to fail-closed require', async () => {
    await expect(deleteScope(USER, 'work')).resolves.toBeUndefined()

    expect(lockRetrievalScopePolicy).toHaveBeenCalledWith(tx, USER)
    expect(deleteScopeDb).toHaveBeenCalledWith(tx, USER, 'work')
    expect(replaceRetrievalPolicyDefault).toHaveBeenCalledWith(tx, USER, 'work', {
      mode: 'require',
      defaultScope: null,
    })
    expect(lockRetrievalScopePolicy.mock.invocationCallOrder[0]).toBeLessThan(
      deleteScopeDb.mock.invocationCallOrder[0] ?? 0,
    )
    expect(deleteScopeDb.mock.invocationCallOrder[0]).toBeLessThan(
      replaceRetrievalPolicyDefault.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('does not rewrite policy when the registry mutation fails', async () => {
    renameScopeDb.mockRejectedValue(new Error('missing'))

    await expect(renameScope(USER, 'missing', 'client')).rejects.toThrow('missing')

    expect(replaceRetrievalPolicyDefault).not.toHaveBeenCalled()
  })
})
