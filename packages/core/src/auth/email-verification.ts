// SPDX-License-Identifier: Apache-2.0
// Self-serve signup email verification. Mirrors reset-token discipline: high
// entropy token, DB stores only SHA-256, no account enumeration, and verification
// consumes the token atomically before minting a normal session.
import { createHash, randomBytes } from 'node:crypto'
import {
  DuplicateEmailError,
  getUserByEmail,
  insertEmailVerificationToken,
  insertUnverifiedUserWithEmailVerificationToken,
  peekEmailVerificationToken,
  replaceEmailVerificationTokens,
  retryUnverifiedSignupWithEmailVerificationToken,
  type SignupEmailVerificationToken,
  type UserRow,
  verifyEmailTokenAtomic,
} from '@3ngram/db'
import { userCredentialsSchema } from '@3ngram/schema'
import type { EmbedOptions } from '../write/embed.js'
import { hashPassword } from './password.js'
import { provisionVerifiedAccount } from './provisioning.js'
import { issueSession, type SessionGrant } from './sessions.js'

const TOKEN_BYTES = 32
const MS_PER_MINUTE = 60 * 1000
const MAX_UNVERIFIED_PASSWORD_REPLACE_ATTEMPTS = 3

export class InvalidEmailVerificationTokenError extends Error {
  constructor() {
    super('email verification token is invalid or expired')
    this.name = 'InvalidEmailVerificationTokenError'
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashEmailVerificationToken(token: string): string {
  return sha256Hex(token)
}

function hashClientProof(clientProof: string): string {
  return sha256Hex(clientProof)
}

interface MintedEmailVerificationToken {
  plaintext: string
  stored: SignupEmailVerificationToken
}

function mintEmailVerificationToken(
  ttlMinutes: number,
  clientProofHash: string,
): MintedEmailVerificationToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url')
  return {
    plaintext,
    stored: {
      tokenHash: hashEmailVerificationToken(plaintext),
      clientProofHash,
      expiresAt: new Date(Date.now() + ttlMinutes * MS_PER_MINUTE),
    },
  }
}

export async function requestEmailVerification(
  userId: string,
  clientProofHash: string,
  ttlMinutes: number,
): Promise<string> {
  const token = mintEmailVerificationToken(ttlMinutes, clientProofHash)
  await insertEmailVerificationToken(userId, token.stored)
  return token.plaintext
}

async function replaceUnverifiedPasswordAndRequestVerification(
  user: UserRow,
  passwordHash: string,
  clientProofHash: string,
  ttlMinutes: number,
): Promise<string | undefined> {
  let current = user
  for (let attempt = 0; attempt < MAX_UNVERIFIED_PASSWORD_REPLACE_ATTEMPTS; attempt += 1) {
    if (current.emailVerifiedAt !== null) return undefined
    const token = mintEmailVerificationToken(ttlMinutes, clientProofHash)
    if (
      await retryUnverifiedSignupWithEmailVerificationToken(
        current.id,
        current.passwordHash,
        passwordHash,
        token.stored,
      )
    ) {
      return token.plaintext
    }

    const refreshed = await getUserByEmail(current.email)
    if (refreshed === undefined || refreshed.emailVerifiedAt !== null) return undefined
    current = refreshed
  }

  return undefined
}

/**
 * Create an unverified account if needed and mint a verification token. Returns
 * undefined for already-verified duplicate emails so the transport can keep one
 * neutral response without sending a misleading link. Unverified duplicates get
 * their password replaced and old links burned atomically with fresh token
 * minting. Every token is bound to a caller-held proof so an unsolicited email
 * click cannot activate a password chosen by a different browser/client.
 */
export async function requestSignup(
  email: string,
  password: string,
  clientProofHash: string,
  ttlMinutes: number,
): Promise<string | undefined> {
  const credentials = userCredentialsSchema.parse({ email, password })
  const existing = await getUserByEmail(credentials.email)
  if (existing !== undefined) {
    if (existing.emailVerifiedAt !== null) return undefined
    const passwordHash = await hashPassword(credentials.password)
    return replaceUnverifiedPasswordAndRequestVerification(
      existing,
      passwordHash,
      clientProofHash,
      ttlMinutes,
    )
  }

  const passwordHash = await hashPassword(credentials.password)
  const token = mintEmailVerificationToken(ttlMinutes, clientProofHash)
  try {
    await insertUnverifiedUserWithEmailVerificationToken(
      credentials.email,
      passwordHash,
      token.stored,
    )
    return token.plaintext
  } catch (error) {
    if (!(error instanceof DuplicateEmailError)) throw error
    const raced = await getUserByEmail(credentials.email)
    if (raced?.emailVerifiedAt === null) {
      return replaceUnverifiedPasswordAndRequestVerification(
        raced,
        passwordHash,
        clientProofHash,
        ttlMinutes,
      )
    }
    return undefined
  }
}

/**
 * Resend a verification link. Looks up the account by email and, for an
 * UNVERIFIED account, mints a fresh token bound to the caller-held proof and
 * supersedes the prior link — but ONLY when an unconsumed token already exists
 * for that proof ("proof continuity", enforced atomically in the db helper). The
 * caller-supplied proof alone is not authority: a resend mints a token without
 * touching the password it verifies into, so a stale proof (whose token was
 * consumed by a competing signup that replaced the password) must not be able to
 * re-activate a link — otherwise verifying it would confirm the account under the
 * other party's password (takeover). For an unknown / already-verified email, or
 * a proof with no live token, it returns undefined — the transport still answers a
 * neutral 202, so all cases are indistinguishable (no enumeration). Never log the
 * email or token (hard rule 6).
 */
export async function resendEmailVerification(
  email: string,
  clientProofHash: string,
  ttlMinutes: number,
): Promise<string | undefined> {
  const user = await getUserByEmail(email)
  if (user === undefined || user.emailVerifiedAt !== null) return undefined
  const token = mintEmailVerificationToken(ttlMinutes, clientProofHash)
  const minted = await replaceEmailVerificationTokens(user.id, token.stored)
  return minted ? token.plaintext : undefined
}

export async function verifyEmail(
  token: string,
  clientProof: string,
  sessionTtlHours: number,
  provisionOptions: EmbedOptions = {},
): Promise<SessionGrant> {
  const tokenHash = hashEmailVerificationToken(token)
  const clientProofHash = hashClientProof(clientProof)
  if ((await peekEmailVerificationToken(tokenHash, clientProofHash)) === undefined) {
    throw new InvalidEmailVerificationTokenError()
  }
  const userId = await verifyEmailTokenAtomic(tokenHash, clientProofHash)
  if (userId === undefined) throw new InvalidEmailVerificationTokenError()

  // First-account provisioning: seed the default scopes + welcome
  // memory so the new account's first recall is non-empty. Runs here —
  // not at requestSignup — because the token is consumed exactly once, so this
  // fires once per account. FIRE-AND-FORGET and never awaited: the token is
  // already consumed above, so a slow/locked DB during provisioning must not
  // delay or hang the verification response (an HTTP timeout would strand the
  // user with a verified account, no session, and a single-use link that can no
  // longer replay — seed failure must not block or alter verification).
  // Errors are swallowed and the dashboard re-seeds on next load (the
  // deferred path). Nothing logged here (hard rule 6).
  void provisionVerifiedAccount(userId, provisionOptions).catch(() => {})

  return issueSession(userId, sessionTtlHours)
}
