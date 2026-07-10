// SPDX-License-Identifier: Apache-2.0
// Unit tests for the forgotten-password reset orchestration.
// Isolated from Postgres by mocking the db helpers (the established core-test
// seam, cf. sessions.test.ts). Key invariants:
// - requestPasswordReset() mints a token ONLY for a known email and returns
//   undefined (minting nothing) for an unknown email — the no-enumeration
//   contract: the caller responds 200 either way.
// - resetPassword() delegates to the atomic resetPasswordAtomic resolver
//   (migrations/0016): consume + rotate + revoke-all-sessions + burn-siblings in
//   one serialized tx. It argon2-hashes the new password (plaintext never crosses
//   the boundary); a resolver result of undefined (unknown/expired/consumed/
//   race-lost token) throws InvalidResetTokenError BEFORE the caller writes.
import { createHash } from 'node:crypto'
import type { UserRow } from '@3ngram/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PwnedRangeFetcher } from '../src/auth/password-breach.js'
import { PasswordBreachedError } from '../src/auth/password-breach.js'

const USER_ID = '0190a000-0000-7000-8000-0000000000aa'

/** SHA-1 upper-hex suffix (chars 5..) the HIBP range API keys a hit under. */
function suffixOf(password: string): string {
  return createHash('sha1').update(password).digest('hex').toUpperCase().slice(5)
}

/** A range body that reports `password` as breached, padded with decoy lines. */
function corpusHitBody(password: string, count = 42): string {
  return [
    '0000000000000000000000000000000000A:1',
    `${suffixOf(password)}:${count}`,
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9',
  ].join('\r\n')
}

let storedUser: UserRow | undefined
let peekUserId: string | undefined
let resetUserId: string | undefined

const getUserByEmail = vi.fn(async (_email: string): Promise<UserRow | undefined> => storedUser)
const insertPasswordResetToken = vi.fn(
  async (_userId: string, _token: { tokenHash: string; expiresAt: Date }): Promise<void> => {},
)
const peekResetToken = vi.fn(async (_tokenHash: string): Promise<string | undefined> => peekUserId)
const resetPasswordAtomic = vi.fn(
  async (_tokenHash: string, _newPasswordHash: string): Promise<string | undefined> => resetUserId,
)

vi.mock('@3ngram/db', () => ({
  getUserByEmail,
  insertPasswordResetToken,
  peekResetToken,
  resetPasswordAtomic,
}))

const { requestPasswordReset, resetPassword, InvalidResetTokenError } = await import(
  '../src/auth/reset-tokens.js'
)

beforeEach(() => {
  vi.clearAllMocks()
  storedUser = {
    id: USER_ID,
    email: 'user@test.local',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: 'old-hash',
  }
  peekUserId = USER_ID
  resetUserId = USER_ID
})

describe('requestPasswordReset (no account enumeration)', () => {
  it('mints + stores a hashed token for a KNOWN email and returns the plaintext', async () => {
    const token = await requestPasswordReset('user@test.local', 30)
    expect(typeof token).toBe('string')
    expect(token?.length).toBeGreaterThan(0)
    expect(insertPasswordResetToken).toHaveBeenCalledTimes(1)
    const [userId, stored] = insertPasswordResetToken.mock.calls[0]
    expect(userId).toBe(USER_ID)
    // The DB never sees the plaintext — only its hash, which differs from it.
    expect(stored.tokenHash).not.toBe(token)
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.expiresAt).toBeInstanceOf(Date)
  })

  it('stamps the reset token to expire at the supplied TTL — 60 min for the 1h reset link (FR-018, T027)', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-06-24T12:00:00.000Z')
      vi.setSystemTime(now)
      await requestPasswordReset('user@test.local', 60)
      const [, stored] = insertPasswordResetToken.mock.calls[0]
      // 1h reset lifetime (spec clarification, RESET_TOKEN_TTL_MINUTES=60).
      expect(stored.expiresAt.getTime()).toBe(now.getTime() + 60 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mints NOTHING and returns undefined for an UNKNOWN email (indistinguishable)', async () => {
    storedUser = undefined
    await expect(requestPasswordReset('nobody@test.local', 30)).resolves.toBeUndefined()
    expect(insertPasswordResetToken).not.toHaveBeenCalled()
  })
})

describe('resetPassword', () => {
  it('peeks then delegates to the atomic resolver with the token HASH and the argon2 hash', async () => {
    await resetPassword('plaintext-token', 'a-brand-new-password')
    expect(peekResetToken).toHaveBeenCalledTimes(1)
    expect(resetPasswordAtomic).toHaveBeenCalledTimes(1)
    // Both the peek and the atomic call see the same sha256 hash, never plaintext.
    const peekHash = peekResetToken.mock.calls[0][0]
    const [tokenHash, newHash] = resetPasswordAtomic.mock.calls[0]
    expect(peekHash).toBe(tokenHash)
    expect(tokenHash).not.toBe('plaintext-token')
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // The new password is argon2id-hashed before it crosses the boundary.
    expect(newHash).not.toBe('a-brand-new-password')
  })

  it('rejects an invalid token BEFORE hashing — no argon2, no atomic call (DoS guard)', async () => {
    // The cheap peek fails first, so the expensive hash + resolver never run.
    peekUserId = undefined
    await expect(resetPassword('bad-token', 'a-brand-new-password')).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    )
    expect(resetPasswordAtomic).not.toHaveBeenCalled()
  })

  it('throws InvalidResetTokenError when the atomic resolver loses a race (peek ok, resolver undefined)', async () => {
    // Token valid at peek but consumed by a concurrent reset before the atomic
    // call — the under-lock re-check is the authority and returns undefined.
    resetUserId = undefined
    await expect(resetPassword('plaintext-token', 'a-brand-new-password')).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    )
    expect(resetPasswordAtomic).toHaveBeenCalledTimes(1)
  })

  it('is single-use: a replay after consumption is rejected (T027)', async () => {
    // First reset consumes the token atomically and succeeds. A replay of the SAME
    // plaintext then finds the token gone: the atomic resolver returns undefined
    // and the caller throws the uniform InvalidResetTokenError — no second rotation.
    resetUserId = USER_ID
    await expect(resetPassword('plaintext-token', 'a-brand-new-password')).resolves.toBeUndefined()
    expect(resetPasswordAtomic).toHaveBeenCalledTimes(1)

    // Replay: the now-consumed token is gone, so the cheap peek already fails
    // (the DB filters consumed/expired tokens out of the peek) — the expensive
    // argon2 hash + atomic resolver never run again (replay DoS guard).
    peekUserId = undefined
    await expect(resetPassword('plaintext-token', 'a-brand-new-password')).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    )
    expect(resetPasswordAtomic).toHaveBeenCalledTimes(1)
  })

  it('rejects a guessed/unknown token uniformly (no enumeration of which tokens existed) (T027)', async () => {
    peekUserId = undefined
    await expect(resetPassword('a-guessed-token', 'a-brand-new-password')).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    )
    expect(resetPasswordAtomic).not.toHaveBeenCalled()
  })

  it('rejects a breached new password AFTER a valid peek but BEFORE rotating or consuming the token', async () => {
    // The breach screen runs between the cheap token peek and the password
    // rotation (research R3): a valid token + a corpus-present password throws
    // PasswordBreachedError, so the token is NOT consumed and the password is
    // NOT rotated — the user retries with a stronger one against the same link.
    const breachedPassword = 'breached-reset-password'
    const fetchRange: PwnedRangeFetcher = async () => corpusHitBody(breachedPassword)
    await expect(
      resetPassword('plaintext-token', breachedPassword, { enabled: true, fetchRange }),
    ).rejects.toBeInstanceOf(PasswordBreachedError)
    // The peek already ran (token is valid), but the breach throw aborts BEFORE
    // the atomic consume+rotate, so no password rotation and no token burn.
    expect(peekResetToken).toHaveBeenCalledTimes(1)
    expect(resetPasswordAtomic).not.toHaveBeenCalled()
  })
})
