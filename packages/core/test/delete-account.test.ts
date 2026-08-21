// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. deleteAccount()'s POLICY: it runs the optional platform
// cleanup hook BEFORE the irreversible erasure (so a transient failure retries
// cleanly — P1), runs eraseAccountData inside withTenant, then writes a
// content-free audit tombstone EXACTLY ONCE (existence-checked, so a retry that
// completes a prior run does not duplicate it). packages/db is mocked; the real
// PII redaction + grant behaviour (no memory-row DELETE, oauth_codes deletion) is
// proven in packages/db integration tests against Postgres (account-delete.int.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'

const eraseAccountData = vi.fn()
const insertAuditLog = vi.fn(async (..._args: unknown[]) => {})
const auditLogEntryExists = vi.fn(async (..._args: unknown[]) => false)
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

vi.mock('@3ngram/db', () => ({
  eraseAccountData: (...args: unknown[]) => eraseAccountData(...args),
  insertAuditLog: (...args: unknown[]) => insertAuditLog(...args),
  auditLogEntryExists: (...args: unknown[]) => auditLogEntryExists(...args),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
}))

const { deleteAccount } = await import('../src/account/delete-account.js')

const NOW = new Date('2026-06-27T00:00:00.000Z')

/** A fake platform cleanup hook, typed to the onAccountDeletion contract. */
function fakeHook() {
  return vi.fn(async (_userId: string) => {})
}

const fullErasure = {
  alreadyErased: false,
  memories: 3,
  facts: 2,
  commitments: 1,
  proposals: 0,
  factProposals: 0,
  agentSessions: 1,
  sessionsDeleted: 2,
  apiKeysRevoked: 1,
  oauthTokensRevoked: 1,
  oauthCodesDeleted: 2,
  passwordResetTokensDeleted: 1,
  emailVerificationTokensDeleted: 1,
}

afterEach(() => {
  eraseAccountData.mockReset()
  insertAuditLog.mockClear()
  auditLogEntryExists.mockReset()
  auditLogEntryExists.mockResolvedValue(false)
  withTenant.mockClear()
})

describe('deleteAccount — policy', () => {
  it('runs the cleanup hook, erases under withTenant, and writes a content-free tombstone', async () => {
    eraseAccountData.mockResolvedValue(fullErasure)
    const onAccountDeletion = fakeHook()

    const result = await deleteAccount('u1', { onAccountDeletion, now: NOW })

    expect(onAccountDeletion).toHaveBeenCalledWith('u1')
    expect(withTenant).toHaveBeenCalledWith('u1', expect.any(Function))
    expect(eraseAccountData).toHaveBeenCalledWith(expect.anything(), 'u1', NOW)
    expect(result).toEqual({ alreadyDeleted: false, erased: fullErasure })

    // The hook runs BEFORE the erasure (P1: a transient failure must leave nothing
    // half-done).
    const hookOrder = onAccountDeletion.mock.invocationCallOrder[0] ?? 0
    const eraseOrder = eraseAccountData.mock.invocationCallOrder[0] ?? 0
    expect(hookOrder).toBeLessThan(eraseOrder)

    // The audit tombstone carries counts + a mechanism label — NEVER email/content.
    expect(insertAuditLog).toHaveBeenCalledTimes(1)
    const entry = insertAuditLog.mock.calls[0]?.[0] as {
      userId: string
      action: string
      metadata: Record<string, unknown>
    }
    expect(entry.userId).toBe('u1')
    expect(entry.action).toBe('account.deleted')
    expect(entry.metadata.mechanism).toBe('pii_tombstone')
    expect(entry.metadata).toMatchObject({
      memories: 3,
      facts: 2,
      commitments: 1,
      oauthCodesDeleted: 2,
      passwordResetTokensDeleted: 1,
      emailVerificationTokensDeleted: 1,
    })
    expect(JSON.stringify(entry)).not.toMatch(/@|content/i)
  })

  it('completes with no hook injected (self-host): erases and writes the tombstone', async () => {
    eraseAccountData.mockResolvedValue(fullErasure)

    const result = await deleteAccount('u1', { now: NOW })

    expect(result).toEqual({ alreadyDeleted: false, erased: fullErasure })
    expect(eraseAccountData).toHaveBeenCalledWith(expect.anything(), 'u1', NOW)
    expect(insertAuditLog).toHaveBeenCalledTimes(1)
  })

  it('idempotent re-run: re-runs the hook (no-op) and does NOT duplicate an existing tombstone', async () => {
    eraseAccountData.mockResolvedValue({ ...fullErasure, alreadyErased: true })
    auditLogEntryExists.mockResolvedValue(true)
    const onAccountDeletion = fakeHook()

    const result = await deleteAccount('u1', { onAccountDeletion, now: NOW })

    expect(result.alreadyDeleted).toBe(true)
    expect(onAccountDeletion).toHaveBeenCalledWith('u1')
    expect(insertAuditLog).not.toHaveBeenCalled()
  })

  it('completes a prior run on retry: erasure already committed but the tombstone never landed', async () => {
    eraseAccountData.mockResolvedValue({ ...fullErasure, alreadyErased: true })
    auditLogEntryExists.mockResolvedValue(false)
    const onAccountDeletion = fakeHook()

    const result = await deleteAccount('u1', { onAccountDeletion, now: NOW })

    expect(result.alreadyDeleted).toBe(true)
    expect(onAccountDeletion).toHaveBeenCalledWith('u1')
    // The missing tombstone is written exactly once to finalize the deletion.
    expect(insertAuditLog).toHaveBeenCalledTimes(1)
  })

  it('treats an absent user row as an idempotent no-op success (deleted mid-request)', async () => {
    eraseAccountData.mockResolvedValue(undefined)
    const onAccountDeletion = fakeHook()

    const result = await deleteAccount('u1', { onAccountDeletion, now: NOW })

    expect(result.alreadyDeleted).toBe(true)
    // The hook runs before erasure, so it is invoked even here (idempotent).
    expect(onAccountDeletion).toHaveBeenCalledWith('u1')
    expect(insertAuditLog).not.toHaveBeenCalled()
  })

  it('partial failure is retryable: the hook throws first, nothing is erased, a retry completes (P1)', async () => {
    eraseAccountData.mockResolvedValue(fullErasure)
    const onAccountDeletion = fakeHook()
    onAccountDeletion
      .mockRejectedValueOnce(new Error('cleanup timeout'))
      .mockResolvedValueOnce(undefined)

    // First attempt: the hook throws BEFORE any irreversible work.
    await expect(deleteAccount('u1', { onAccountDeletion, now: NOW })).rejects.toThrow(
      'cleanup timeout',
    )
    expect(eraseAccountData).not.toHaveBeenCalled()
    expect(insertAuditLog).not.toHaveBeenCalled()

    // Retry: the hook now succeeds and the deletion completes end to end.
    const result = await deleteAccount('u1', { onAccountDeletion, now: NOW })
    expect(result).toEqual({ alreadyDeleted: false, erased: fullErasure })
    expect(eraseAccountData).toHaveBeenCalledTimes(1)
    expect(insertAuditLog).toHaveBeenCalledTimes(1)
  })
})
