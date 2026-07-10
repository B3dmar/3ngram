// SPDX-License-Identifier: Apache-2.0
// Unit tests for changePassword. Isolated from Postgres by mocking
// the two id-keyed admin db helpers (the established core-test seam, cf.
// sessions.test.ts). Key invariants: a correct current password persists a NEW
// argon2id hash of the new password; a wrong current password (or a missing
// user) throws InvalidCurrentPasswordError and the stored hash is UNCHANGED;
// and a compare-and-swap that matches zero rows (concurrent rotation / TOCTOU)
// throws InvalidCurrentPasswordError rather than reporting success.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

const CURRENT_PASSWORD = 'current-password-123'
const NEW_PASSWORD = 'a-brand-new-password-456'
const USER_ID = '0190a000-0000-7000-8000-000000000002'

let storedHash: string | undefined

const getUserPasswordHashById = vi.fn(
  async (_userId: string): Promise<string | undefined> => storedHash,
)
const updateUserPassword = vi.fn(
  async (_userId: string, expectedHash: string, passwordHash: string): Promise<boolean> => {
    // Compare-and-swap: only persist when the stored hash still matches the one
    // the caller verified. A mismatch (concurrent rotation) writes zero rows.
    if (storedHash !== expectedHash) return false
    storedHash = passwordHash
    return true
  },
)
// insertUser is exported alongside but unused here; mock it to satisfy the import.
const insertUser = vi.fn()
vi.mock('@3ngram/db', () => ({ getUserPasswordHashById, updateUserPassword, insertUser }))

const { changePassword, InvalidCurrentPasswordError } = await import('../src/auth/users.js')

beforeEach(async () => {
  vi.clearAllMocks()
  storedHash = await hashPassword(CURRENT_PASSWORD)
})

describe('changePassword', () => {
  it('persists a new hash of the new password when the current password is correct', async () => {
    const hashBefore = storedHash
    await expect(changePassword(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD)).resolves.toBeUndefined()

    expect(updateUserPassword).toHaveBeenCalledTimes(1)
    const [calledUserId, expectedHash, persistedHash] = updateUserPassword.mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(calledUserId).toBe(USER_ID)
    // The CAS predicate is the just-verified hash, closing the TOCTOU window.
    expect(expectedHash).toBe(hashBefore)
    // A real argon2id rotation: the persisted hash differs from the old one and
    // verifies against the new password, not the old.
    expect(persistedHash).not.toBe(hashBefore)
    await expect(verifyPassword(persistedHash, NEW_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(persistedHash, CURRENT_PASSWORD)).resolves.toBe(false)
  })

  it('rejects a wrong current password and leaves the stored hash unchanged', async () => {
    const hashBefore = storedHash
    await expect(changePassword(USER_ID, 'wrong-password', NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(updateUserPassword).not.toHaveBeenCalled()
    expect(storedHash).toBe(hashBefore)
  })

  it('rejects (uniform 401 path) when the user id resolves to no stored hash', async () => {
    storedHash = undefined
    await expect(changePassword(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(updateUserPassword).not.toHaveBeenCalled()
  })

  it('rejects when the compare-and-swap matches no row (concurrent rotation / TOCTOU)', async () => {
    // Simulate a concurrent rotation landing between the verify read and the
    // swap: the verified hash is correct, but the stored hash has since moved,
    // so the CAS writes zero rows and the call must fail rather than report ok.
    updateUserPassword.mockResolvedValueOnce(false)
    await expect(changePassword(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidCurrentPasswordError,
    )
    expect(updateUserPassword).toHaveBeenCalledTimes(1)
  })
})
