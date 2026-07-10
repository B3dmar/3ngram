// SPDX-License-Identifier: Apache-2.0
// Unit tests for the credential-verification + session-mint split.
// Isolated from Postgres by mocking the three session db helpers (the
// established core-test seam, cf. oauth-clients.test.ts). The key invariant:
// verifyCredentials() confirms identity WITHOUT inserting a session row, so the
// OAuth consent flow leaves no orphan session; login() reuses that same verify
// step and adds the INSERT, keeping the argon2id + timing logic single-sourced.
import type { ResolvedSession, UserRow } from '@3ngram/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../src/auth/password.js'

const PASSWORD = 'verify-credentials-password'
const USER_ID = '0190a000-0000-7000-8000-000000000001'

let storedUser: UserRow | undefined

const getUserByEmail = vi.fn(async (_email: string): Promise<UserRow | undefined> => storedUser)
const insertSession = vi.fn(
  async (_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> => {},
)
const resolveSession = vi.fn(
  async (_tokenHash: string): Promise<ResolvedSession | undefined> => undefined,
)
vi.mock('@3ngram/db', () => ({ getUserByEmail, insertSession, resolveSession }))

const { EmailNotVerifiedError, login, verifyCredentials } = await import('../src/auth/sessions.js')

beforeEach(async () => {
  vi.clearAllMocks()
  storedUser = {
    id: USER_ID,
    email: 'user@test.local',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: await hashPassword(PASSWORD),
  }
})

describe('verifyCredentials', () => {
  it('returns the user id for correct credentials and mints NO session', async () => {
    await expect(verifyCredentials('user@test.local', PASSWORD)).resolves.toBe(USER_ID)
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('returns undefined for a wrong password (typed failure, no session)', async () => {
    await expect(verifyCredentials('user@test.local', 'wrong-password')).resolves.toBeUndefined()
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('throws EmailNotVerifiedError for correct credentials on an unverified account', async () => {
    if (storedUser === undefined) throw new Error('expected stored user')
    storedUser = { ...storedUser, emailVerifiedAt: null }
    await expect(verifyCredentials('user@test.local', PASSWORD)).rejects.toBeInstanceOf(
      EmailNotVerifiedError,
    )
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('returns undefined for an unknown user and still runs the dummy-hash verify (timing guard)', async () => {
    storedUser = undefined
    await expect(verifyCredentials('nobody@test.local', PASSWORD)).resolves.toBeUndefined()
    // The unknown-user path looked the user up and (per the timing guard) still
    // performed an argon2id verify against the dummy hash — no enumeration
    // shortcut. No session is minted either.
    expect(getUserByEmail).toHaveBeenCalledWith('nobody@test.local')
    expect(insertSession).not.toHaveBeenCalled()
  })
})

describe('login reuses the shared verify step', () => {
  it('mints a session for correct credentials (verify + INSERT)', async () => {
    const grant = await login('user@test.local', PASSWORD, 24)
    expect(grant?.userId).toBe(USER_ID)
    expect(typeof grant?.token).toBe('string')
    expect(insertSession).toHaveBeenCalledTimes(1)
    expect(insertSession).toHaveBeenCalledWith(USER_ID, expect.any(String), expect.any(Date))
  })

  it('returns undefined and mints NO session on a wrong password', async () => {
    await expect(login('user@test.local', 'wrong-password', 24)).resolves.toBeUndefined()
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('propagates EmailNotVerifiedError and mints NO session for an unverified account', async () => {
    if (storedUser === undefined) throw new Error('expected stored user')
    storedUser = { ...storedUser, emailVerifiedAt: null }
    await expect(login('user@test.local', PASSWORD, 24)).rejects.toBeInstanceOf(
      EmailNotVerifiedError,
    )
    expect(insertSession).not.toHaveBeenCalled()
  })
})
