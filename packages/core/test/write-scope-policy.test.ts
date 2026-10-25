// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The write-scope policy surface (issue #235): resolving
// the effective policy, resolving an omitted scope per mode, and the
// set_write_default registry check (canonical names only, aliases rejected).
// RLS and the real row are covered by the db and server integration suites.
import { afterEach, describe, expect, it, vi } from 'vitest'

const tx = { kind: 'tenant-tx' }
const withTenant = vi.fn(async (_userId: string, fn: (value: unknown) => Promise<unknown>) =>
  fn(tx),
)
const getWriteScopePolicy = vi.fn(async (_tx: unknown, _userId: string): Promise<unknown> => null)
const upsertWriteScopePolicy = vi.fn(
  async (_tx: unknown, _userId: string, policy: { mode: string; defaultScope: string | null }) => ({
    ...policy,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  }),
)
const listScopes = vi.fn(async (_tx: unknown, _userId: string): Promise<unknown[]> => [])
const lockScopePolicies = vi.fn(async (_tx: unknown, _userId: string) => undefined)

class ScopeNotFoundError extends Error {
  readonly scopeName: string
  constructor(scopeName: string) {
    super(`no scope named "${scopeName}" for this tenant`)
    this.name = 'ScopeNotFoundError'
    this.scopeName = scopeName
  }
}

vi.mock('@3ngram/db', () => ({
  withTenant: (userId: string, fn: (value: unknown) => Promise<unknown>) => withTenant(userId, fn),
  getWriteScopePolicy: (t: unknown, userId: string) => getWriteScopePolicy(t, userId),
  upsertWriteScopePolicy: (
    t: unknown,
    userId: string,
    policy: { mode: string; defaultScope: string | null },
  ) => upsertWriteScopePolicy(t, userId, policy),
  listScopes: (t: unknown, userId: string) => listScopes(t, userId),
  lockScopePolicies: (t: unknown, userId: string) => lockScopePolicies(t, userId),
  ScopeNotFoundError,
}))

const {
  formatUnscopedWriteDetail,
  resolveWriteScope,
  resolveWriteScopePolicy,
  setWriteDefault,
  toWriteScopeSetting,
  UnscopedWriteError,
} = await import('../src/scope/write-policy.js')

const USER = '00000000-0000-7000-8000-000000000001'
const row = (mode: 'off' | 'default' | 'require', defaultScope: string | null) => ({
  mode,
  defaultScope,
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
})
const scope = (name: string, aliases: string[] = []) => ({
  id: `id-${name}`,
  name,
  aliases,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
})

afterEach(() => {
  vi.clearAllMocks()
  getWriteScopePolicy.mockResolvedValue(null)
  listScopes.mockResolvedValue([])
})

describe('resolveWriteScopePolicy', () => {
  it("reports 'off' when no row is stored (the default every tenant starts with)", async () => {
    await expect(resolveWriteScopePolicy(USER)).resolves.toEqual({ mode: 'off', scope: null })
    expect(withTenant).toHaveBeenCalledExactlyOnceWith(USER, expect.any(Function))
    expect(getWriteScopePolicy).toHaveBeenCalledExactlyOnceWith(tx, USER)
  })

  it('reports a stored policy verbatim', async () => {
    getWriteScopePolicy.mockResolvedValue(row('default', 'work'))
    await expect(resolveWriteScopePolicy(USER)).resolves.toEqual({ mode: 'default', scope: 'work' })
    getWriteScopePolicy.mockResolvedValue(row('require', null))
    await expect(resolveWriteScopePolicy(USER)).resolves.toEqual({ mode: 'require', scope: null })
  })

  it("reports a 'default' row with no scope as 'off', never as an unusable default", async () => {
    getWriteScopePolicy.mockResolvedValue(row('default', null))
    await expect(resolveWriteScopePolicy(USER)).resolves.toEqual({ mode: 'off', scope: null })
  })
})

describe('resolveWriteScope', () => {
  it('uses an explicit scope as given without reading the policy', async () => {
    getWriteScopePolicy.mockResolvedValue(row('require', null))
    // Not registry-checked: memories.scope is denormalized text.
    await expect(resolveWriteScope(USER, 'never-registered')).resolves.toBe('never-registered')
    expect(withTenant).not.toHaveBeenCalled()
  })

  it.each([
    [null, 'personal'],
    [row('off', null), 'personal'],
    [row('default', 'work'), 'work'],
  ])('fills an omitted scope from policy %o -> %s', async (stored, expected) => {
    getWriteScopePolicy.mockResolvedValue(stored)
    await expect(resolveWriteScope(USER, undefined)).resolves.toBe(expected)
  })

  it("throws UnscopedWriteError for an omitted scope under 'require'", async () => {
    getWriteScopePolicy.mockResolvedValue(row('require', null))
    listScopes.mockResolvedValue([scope('personal'), scope('work', ['job'])])
    const error = await resolveWriteScope(USER, undefined).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnscopedWriteError)
    expect((error as Error).name).toBe('UnscopedWriteError')
    // Canonical names only (aliases are not resolved), read in the same tx.
    expect((error as { registeredScopes: readonly string[] }).registeredScopes).toEqual([
      'personal',
      'work',
    ])
    expect((error as Error).message).toBe(
      "this account requires an explicit scope on writes (write-scope mode 'require') — pass scope; registered scopes: personal, work",
    )
    expect(listScopes).toHaveBeenCalledExactlyOnceWith(tx, USER)
    expect(withTenant).toHaveBeenCalledOnce()
  })
})

describe('formatUnscopedWriteDetail', () => {
  it('says any scope name works when none is registered (explicit scopes are not registry-checked)', () => {
    expect(formatUnscopedWriteDetail([])).toBe(
      "this account requires an explicit scope on writes (write-scope mode 'require') — pass scope; any kebab-case scope name is accepted",
    )
  })

  it('stays bounded: at most 8 names, then a count of the rest, within the REST detail cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `scope-${i}`)
    const detail = formatUnscopedWriteDetail(many)
    expect(detail).toContain('scope-7; +12 more omitted')
    expect(detail).not.toContain('scope-8,')
    const long = Array.from({ length: 8 }, (_, i) => `${'x'.repeat(60)}-${i}`)
    expect(formatUnscopedWriteDetail(long).length).toBeLessThanOrEqual(512)
  })
})

describe('toWriteScopeSetting', () => {
  it('is the one row-to-setting mapping (remember and describe_environment share it)', () => {
    expect(toWriteScopeSetting(null)).toEqual({ mode: 'off', scope: null })
    expect(toWriteScopeSetting(row('default', 'work'))).toEqual({ mode: 'default', scope: 'work' })
    expect(toWriteScopeSetting(row('require', null))).toEqual({ mode: 'require', scope: null })
    expect(toWriteScopeSetting(row('default', null))).toEqual({ mode: 'off', scope: null })
  })
})

describe('setWriteDefault', () => {
  it('stores a default on a registered scope under the shared policy lock', async () => {
    listScopes.mockResolvedValue([scope('personal'), scope('work')])

    await expect(setWriteDefault(USER, { mode: 'default', scope: 'work' })).resolves.toEqual({
      mode: 'default',
      scope: 'work',
    })

    expect(lockScopePolicies).toHaveBeenCalledWith(tx, USER)
    expect(upsertWriteScopePolicy).toHaveBeenCalledWith(tx, USER, {
      mode: 'default',
      defaultScope: 'work',
    })
    expect(lockScopePolicies.mock.invocationCallOrder[0]).toBeLessThan(
      upsertWriteScopePolicy.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('rejects an unregistered scope and stores nothing', async () => {
    listScopes.mockResolvedValue([scope('work')])

    await expect(setWriteDefault(USER, { mode: 'default', scope: 'typo' })).rejects.toBeInstanceOf(
      ScopeNotFoundError,
    )
    expect(upsertWriteScopePolicy).not.toHaveBeenCalled()
  })

  it('rejects an alias: aliases are recorded, not resolved, so only the canonical name counts', async () => {
    listScopes.mockResolvedValue([scope('work', ['job'])])

    await expect(setWriteDefault(USER, { mode: 'default', scope: 'job' })).rejects.toMatchObject({
      name: 'ScopeNotFoundError',
      scopeName: 'job',
    })
    expect(upsertWriteScopePolicy).not.toHaveBeenCalled()
  })

  it.each(['off', 'require'] as const)("stores mode '%s' without a registry read", async (mode) => {
    await expect(setWriteDefault(USER, { mode, scope: null })).resolves.toEqual({
      mode,
      scope: null,
    })
    expect(listScopes).not.toHaveBeenCalled()
    expect(upsertWriteScopePolicy).toHaveBeenCalledWith(tx, USER, { mode, defaultScope: null })
  })
})
