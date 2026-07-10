// SPDX-License-Identifier: Apache-2.0
// Unit tests for self-serve signup email verification. Isolated from Postgres
// by mocking the db helpers, matching reset-tokens.test.ts. Key invariants:
// - signup creates unverified users and stores only a SHA-256 token hash;
// - duplicate verified accounts get no token while unverified duplicates can
//   request a fresh one without account enumeration at the transport;
// - verifyEmail() peeks cheaply, delegates the single-use consume to the atomic
//   DB resolver, and mints a normal session only after consume succeeds.
import type { NewEmailVerificationToken, SignupEmailVerificationToken, UserRow } from '@3ngram/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = '0190b000-0000-7000-8000-0000000000aa'
const RACE_USER_ID = '0190b000-0000-7000-8000-0000000000bb'
const EMAIL = 'signup@test.local'
const PASSWORD = 'signup-password-123'
const CLIENT_PROOF = 'signup-client-proof'
const CLIENT_PROOF_HASH = 'a'.repeat(64)

class DuplicateEmailError extends Error {
  constructor() {
    super('email already registered')
    this.name = 'DuplicateEmailError'
  }
}

let storedUser: UserRow | undefined
let peekUserId: string | undefined
let verifiedUserId: string | undefined

const getUserByEmail = vi.fn(async (_email: string): Promise<UserRow | undefined> => storedUser)
const insertUnverifiedUserWithEmailVerificationToken = vi.fn(
  async (
    email: string,
    passwordHash: string,
    _token: SignupEmailVerificationToken,
  ): Promise<UserRow> => ({
    id: USER_ID,
    email,
    emailVerifiedAt: null,
    passwordHash,
  }),
)
const insertEmailVerificationToken = vi.fn(
  async (_userId: string, _token: NewEmailVerificationToken): Promise<void> => {},
)
const peekEmailVerificationToken = vi.fn(
  async (_tokenHash: string): Promise<string | undefined> => peekUserId,
)
const replaceEmailVerificationTokens = vi.fn(
  async (_userId: string, _token: NewEmailVerificationToken): Promise<boolean> => true,
)
const verifyEmailTokenAtomic = vi.fn(
  async (_tokenHash: string): Promise<string | undefined> => verifiedUserId,
)
const insertSession = vi.fn(
  async (_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> => {},
)
const resolveSession = vi.fn(async () => undefined)
const rotatePasswordAndRevokeOthers = vi.fn(async () => true)
const getUserPasswordHashById = vi.fn(async () => undefined)
const updateUserPassword = vi.fn(async () => false)
const retryUnverifiedSignupWithEmailVerificationToken = vi.fn(async () => true)

vi.mock('@3ngram/db', () => ({
  DuplicateEmailError,
  getUserByEmail,
  getUserPasswordHashById,
  insertEmailVerificationToken,
  insertSession,
  insertUnverifiedUserWithEmailVerificationToken,
  peekEmailVerificationToken,
  replaceEmailVerificationTokens,
  resolveSession,
  retryUnverifiedSignupWithEmailVerificationToken,
  rotatePasswordAndRevokeOthers,
  updateUserPassword,
  verifyEmailTokenAtomic,
}))

// verifyEmail fires provisionVerifiedAccount (fire-and-forget). Stub it so these
// unit tests stay scoped to the verification contract and don't pull the real
// provisioning module's scope/remember db exports (which this @3ngram/db mock
// deliberately omits). The provisioning behaviour is covered by its own suite.
const provisionVerifiedAccount = vi.fn(async () => {})
vi.mock('../src/auth/provisioning.js', () => ({ provisionVerifiedAccount }))

const { InvalidEmailVerificationTokenError, requestSignup, resendEmailVerification, verifyEmail } =
  await import('../src/auth/email-verification.js')

function unverifiedUser(id = USER_ID): UserRow {
  return { id, email: EMAIL, emailVerifiedAt: null, passwordHash: 'stored-hash' }
}

function verifiedUser(): UserRow {
  return {
    id: USER_ID,
    email: EMAIL,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: 'stored-hash',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storedUser = undefined
  peekUserId = USER_ID
  verifiedUserId = USER_ID
})

describe('requestSignup', () => {
  it('creates an unverified user and stores only a hashed verification token', async () => {
    const token = await requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 30)

    expect(typeof token).toBe('string')
    expect(insertUnverifiedUserWithEmailVerificationToken).toHaveBeenCalledTimes(1)
    const [email, passwordHash, stored] =
      insertUnverifiedUserWithEmailVerificationToken.mock.calls[0]
    expect(email).toBe(EMAIL)
    expect(passwordHash).not.toBe(PASSWORD)
    expect(stored.tokenHash).not.toBe(token)
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.clientProofHash).toBe(CLIENT_PROOF_HASH)
    expect(stored.expiresAt).toBeInstanceOf(Date)
    expect(insertEmailVerificationToken).not.toHaveBeenCalled()
  })

  it('replaces the password before minting a fresh token for an unverified duplicate', async () => {
    storedUser = unverifiedUser()
    const token = await requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 30)

    expect(typeof token).toBe('string')
    expect(insertUnverifiedUserWithEmailVerificationToken).not.toHaveBeenCalled()
    expect(retryUnverifiedSignupWithEmailVerificationToken).toHaveBeenCalledTimes(1)
    const [userId, expectedHash, passwordHash, stored] =
      retryUnverifiedSignupWithEmailVerificationToken.mock.calls[0]
    expect(userId).toBe(USER_ID)
    expect(expectedHash).toBe('stored-hash')
    expect(passwordHash).not.toBe(PASSWORD)
    expect(passwordHash).not.toBe('stored-hash')
    expect(stored.tokenHash).not.toBe(token)
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.clientProofHash).toBe(CLIENT_PROOF_HASH)
    expect(insertEmailVerificationToken).not.toHaveBeenCalled()
  })

  it('does not mint a token when an unverified retry loses the race to verification', async () => {
    getUserByEmail.mockResolvedValueOnce(unverifiedUser()).mockResolvedValueOnce(verifiedUser())
    retryUnverifiedSignupWithEmailVerificationToken.mockResolvedValueOnce(false)

    await expect(requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 30)).resolves.toBeUndefined()

    expect(retryUnverifiedSignupWithEmailVerificationToken).toHaveBeenCalledTimes(1)
    expect(insertEmailVerificationToken).not.toHaveBeenCalled()
  })

  it('stamps the verification token to expire at the supplied TTL — 1440 min for the 24h link (FR-018, T027)', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-06-24T12:00:00.000Z')
      vi.setSystemTime(now)
      await requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 1440)
      const [, , stored] = insertUnverifiedUserWithEmailVerificationToken.mock.calls[0]
      // 24h verification lifetime (spec clarification, EMAIL_VERIFICATION_TOKEN_TTL_MINUTES=1440).
      expect(stored.expiresAt.getTime()).toBe(now.getTime() + 1440 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns undefined for an already verified duplicate account', async () => {
    storedUser = verifiedUser()
    await expect(requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 30)).resolves.toBeUndefined()
    expect(insertUnverifiedUserWithEmailVerificationToken).not.toHaveBeenCalled()
    expect(insertEmailVerificationToken).not.toHaveBeenCalled()
  })

  it('handles a duplicate-email race by replacing the unverified winner password', async () => {
    getUserByEmail
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(unverifiedUser(RACE_USER_ID))
    insertUnverifiedUserWithEmailVerificationToken.mockRejectedValueOnce(new DuplicateEmailError())

    const token = await requestSignup(EMAIL, PASSWORD, CLIENT_PROOF_HASH, 30)

    expect(typeof token).toBe('string')
    expect(retryUnverifiedSignupWithEmailVerificationToken).toHaveBeenCalledTimes(1)
    expect(retryUnverifiedSignupWithEmailVerificationToken.mock.calls[0][0]).toBe(RACE_USER_ID)
    expect(retryUnverifiedSignupWithEmailVerificationToken.mock.calls[0][3]).toEqual(
      expect.objectContaining({ tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    )
    expect(insertEmailVerificationToken).not.toHaveBeenCalled()
  })
})

describe('verifyEmail', () => {
  it('peeks then delegates to the atomic resolver with the token HASH before minting a session', async () => {
    const grant = await verifyEmail('plaintext-token', CLIENT_PROOF, 24)

    expect(grant.userId).toBe(USER_ID)
    expect(typeof grant.token).toBe('string')
    expect(peekEmailVerificationToken).toHaveBeenCalledTimes(1)
    expect(verifyEmailTokenAtomic).toHaveBeenCalledTimes(1)
    const peekHash = peekEmailVerificationToken.mock.calls[0][0]
    const atomicHash = verifyEmailTokenAtomic.mock.calls[0][0]
    expect(peekHash).toBe(atomicHash)
    expect(atomicHash).not.toBe('plaintext-token')
    expect(atomicHash).toMatch(/^[0-9a-f]{64}$/)
    expect(peekEmailVerificationToken.mock.calls[0][1]).not.toBe(CLIENT_PROOF)
    expect(peekEmailVerificationToken.mock.calls[0][1]).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyEmailTokenAtomic.mock.calls[0][1]).toBe(
      peekEmailVerificationToken.mock.calls[0][1],
    )
    expect(insertSession).toHaveBeenCalledWith(USER_ID, expect.any(String), expect.any(Date))
  })

  it('threads resource limits into fire-and-forget welcome provisioning', async () => {
    const limits = vi.fn().mockResolvedValue({ maxLiveMemories: 1 })

    await verifyEmail('plaintext-token', CLIENT_PROOF, 24, { limits })

    expect(provisionVerifiedAccount).toHaveBeenCalledExactlyOnceWith(USER_ID, { limits })
  })

  it('rejects an invalid token before the atomic resolver or session insert', async () => {
    peekUserId = undefined
    await expect(verifyEmail('bad-token', CLIENT_PROOF, 24)).rejects.toBeInstanceOf(
      InvalidEmailVerificationTokenError,
    )
    expect(verifyEmailTokenAtomic).not.toHaveBeenCalled()
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('is single-use: a replay after the first consume is rejected (T027)', async () => {
    // First verify consumes the token atomically and mints a session.
    peekUserId = USER_ID
    verifiedUserId = USER_ID
    const grant = await verifyEmail('plaintext-token', CLIENT_PROOF, 24)
    expect(grant.userId).toBe(USER_ID)

    // Replay: the token is now consumed, so the cheap peek fails first (the DB
    // filters consumed/expired tokens out of the peek) and the atomic resolver
    // is NOT called a second time — no second session for one verification link.
    peekUserId = undefined
    await expect(verifyEmail('plaintext-token', CLIENT_PROOF, 24)).rejects.toBeInstanceOf(
      InvalidEmailVerificationTokenError,
    )
    expect(verifyEmailTokenAtomic).toHaveBeenCalledTimes(1)
  })

  it('rejects a guessed/unknown token without consuming or minting (T027)', async () => {
    peekUserId = undefined
    await expect(verifyEmail('a-guessed-token', CLIENT_PROOF, 24)).rejects.toBeInstanceOf(
      InvalidEmailVerificationTokenError,
    )
    expect(verifyEmailTokenAtomic).not.toHaveBeenCalled()
    expect(insertSession).not.toHaveBeenCalled()
  })

  it('rejects when the token loses the consume race after a successful peek', async () => {
    verifiedUserId = undefined
    await expect(verifyEmail('plaintext-token', CLIENT_PROOF, 24)).rejects.toBeInstanceOf(
      InvalidEmailVerificationTokenError,
    )
    expect(verifyEmailTokenAtomic).toHaveBeenCalledTimes(1)
    expect(insertSession).not.toHaveBeenCalled()
  })
})

describe('resendEmailVerification', () => {
  it('mints a fresh proof-bound token and supersedes prior links for an unverified account', async () => {
    storedUser = unverifiedUser()

    const token = await resendEmailVerification(EMAIL, CLIENT_PROOF_HASH, 30)

    expect(typeof token).toBe('string')
    expect(replaceEmailVerificationTokens).toHaveBeenCalledTimes(1)
    const [userId, stored] = replaceEmailVerificationTokens.mock.calls[0]
    expect(userId).toBe(USER_ID)
    expect(stored.tokenHash).not.toBe(token) // only the hash is stored
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.clientProofHash).toBe(CLIENT_PROOF_HASH)
    expect(stored.expiresAt).toBeInstanceOf(Date)
  })

  it('returns undefined and supersedes nothing for an unknown email (no enumeration)', async () => {
    storedUser = undefined

    const token = await resendEmailVerification(EMAIL, CLIENT_PROOF_HASH, 30)

    expect(token).toBeUndefined()
    expect(replaceEmailVerificationTokens).not.toHaveBeenCalled()
  })

  it('returns undefined and supersedes nothing for an already-verified account', async () => {
    storedUser = verifiedUser()

    const token = await resendEmailVerification(EMAIL, CLIENT_PROOF_HASH, 30)

    expect(token).toBeUndefined()
    expect(replaceEmailVerificationTokens).not.toHaveBeenCalled()
  })

  it('returns no token when proof continuity fails (no unconsumed token for the proof)', async () => {
    // The account is unverified, but the supplied proof owns no live token (e.g. a
    // competing signup replaced the password + consumed the original token). The db
    // helper mints nothing, so no link is sent — no takeover via a stale proof.
    storedUser = unverifiedUser()
    replaceEmailVerificationTokens.mockResolvedValueOnce(false)

    const token = await resendEmailVerification(EMAIL, CLIENT_PROOF_HASH, 30)

    expect(token).toBeUndefined()
    expect(replaceEmailVerificationTokens).toHaveBeenCalledTimes(1)
  })
})
