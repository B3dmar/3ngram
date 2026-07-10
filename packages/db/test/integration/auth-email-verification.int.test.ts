// SPDX-License-Identifier: Apache-2.0
// Email verification token wrappers against the REAL runtime role (app_user,
// NOBYPASSRLS). Covers the RLS-owned insert path, the pre-tenant SECURITY
// DEFINER peek/verify resolvers, single-use consume, sibling burn, and verified
// timestamp update used by self-serve signup.
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  insertUnverifiedUserWithEmailVerificationToken,
  retryUnverifiedSignupWithEmailVerificationToken,
} from '../../src/auth-admin.js'
import {
  insertEmailVerificationToken,
  peekEmailVerificationToken,
  replaceEmailVerificationTokens,
  verifyEmailTokenAtomic,
} from '../../src/auth-email-verification.js'
import { closeDb, withTenant } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const PROOF = 'signup-client-proof'
const OTHER_PROOF = 'other-signup-client-proof'

let userA: string
let userB: string

beforeAll(async () => {
  userA = await seedUser('email-verify-a@test.local')
  userB = await seedUser('email-verify-b@test.local')
})

beforeEach(async () => {
  await ownerPool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
    [userA, userB],
  ])
  await ownerPool.query('UPDATE users SET email_verified_at = NULL WHERE id = ANY($1)', [
    [userA, userB],
  ])
})

afterAll(async () => {
  const ids = [userA, userB]
  await ownerPool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [ids])
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [ids])
  await closeDb()
  await closePools()
})

async function countLiveVerificationTokens(userId: string): Promise<number> {
  const r = await ownerPool.query(
    'SELECT count(*)::int AS n FROM email_verification_tokens WHERE user_id = $1 AND consumed_at IS NULL',
    [userId],
  )
  return r.rows[0].n as number
}

async function readEmailVerifiedAt(userId: string): Promise<Date | null> {
  const r = await ownerPool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId])
  return r.rows[0].email_verified_at as Date | null
}

async function readPasswordHash(userId: string): Promise<string> {
  const r = await ownerPool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
  return r.rows[0].password_hash as string
}

async function cleanupUser(userId: string): Promise<void> {
  await ownerPool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [userId])
  await ownerPool.query('DELETE FROM users WHERE id = $1', [userId])
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor: condition not met before timeout')
}

describe('email verification tokens (runtime role + SECURITY DEFINER)', () => {
  it('inserts, peeks, verifies once, marks the user verified, and burns siblings', async () => {
    const token = randomUUID()
    const sibling = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(token),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(sibling),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    expect(await countLiveVerificationTokens(userA)).toBe(2)

    expect(await peekEmailVerificationToken(hash(token), hash(PROOF))).toBe(userA)
    expect(await verifyEmailTokenAtomic(hash(token), hash(PROOF))).toBe(userA)

    expect(await readEmailVerifiedAt(userA)).toBeInstanceOf(Date)
    expect(await countLiveVerificationTokens(userA)).toBe(0)
    expect(await peekEmailVerificationToken(hash(token), hash(PROOF))).toBeUndefined()
    expect(await verifyEmailTokenAtomic(hash(token), hash(PROOF))).toBeUndefined()
  })

  it('does not verify a valid email token with the wrong client proof', async () => {
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(token),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    expect(await peekEmailVerificationToken(hash(token), hash(OTHER_PROOF))).toBeUndefined()
    expect(await verifyEmailTokenAtomic(hash(token), hash(OTHER_PROOF))).toBeUndefined()
    expect(await readEmailVerifiedAt(userA)).toBeNull()
    expect(await countLiveVerificationTokens(userA)).toBe(1)
  })

  it('does not verify expired tokens', async () => {
    const token = randomUUID()
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(token),
      clientProofHash: hash(PROOF),
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await peekEmailVerificationToken(hash(token), hash(PROOF))).toBeUndefined()
    expect(await verifyEmailTokenAtomic(hash(token), hash(PROOF))).toBeUndefined()
    expect(await readEmailVerifiedAt(userA)).toBeNull()
    expect(await countLiveVerificationTokens(userA)).toBe(1)
  })

  it('rejects a forged token row for another user via RLS WITH CHECK', async () => {
    await expect(
      withTenant(userB, async (tx) => {
        const { sql } = await import('drizzle-orm')
        await tx.execute(
          sql`INSERT INTO email_verification_tokens (user_id, token_hash, client_proof_hash, expires_at)
              VALUES (${userA}, ${hash(randomUUID())}, ${hash(PROOF)}, now() + interval '1 hour')`,
        )
      }),
    ).rejects.toSatisfy((e: Error) =>
      /row-level security/.test(String((e as { cause?: unknown }).cause ?? e)),
    )
  })

  it('creates an unverified signup and first token atomically', async () => {
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    const user = await insertUnverifiedUserWithEmailVerificationToken(
      `email-verify-created-${randomUUID()}@test.local`,
      'created-hash',
      { tokenHash: hash(token), clientProofHash: hash(PROOF), expiresAt },
    )

    try {
      expect(await readPasswordHash(user.id)).toBe('created-hash')
      expect(await readEmailVerifiedAt(user.id)).toBeNull()
      expect(await countLiveVerificationTokens(user.id)).toBe(1)
      expect(await peekEmailVerificationToken(hash(token), hash(PROOF))).toBe(user.id)
    } finally {
      await cleanupUser(user.id)
    }
  })

  it('replaces an unverified duplicate-signup password and swaps to one fresh link', async () => {
    await ownerPool.query(
      `UPDATE users SET password_hash = 'old-hash', email_verified_at = NULL WHERE id = $1`,
      [userA],
    )
    const token = randomUUID()
    const sibling = randomUUID()
    const fresh = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(token),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(sibling),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    expect(await countLiveVerificationTokens(userA)).toBe(2)

    await expect(
      retryUnverifiedSignupWithEmailVerificationToken(userA, 'old-hash', 'new-hash', {
        tokenHash: hash(fresh),
        clientProofHash: hash(PROOF),
        expiresAt,
      }),
    ).resolves.toBe(true)

    expect(await readPasswordHash(userA)).toBe('new-hash')
    expect(await countLiveVerificationTokens(userA)).toBe(1)
    expect(await peekEmailVerificationToken(hash(token), hash(PROOF))).toBeUndefined()
    expect(await verifyEmailTokenAtomic(hash(token), hash(PROOF))).toBeUndefined()
    expect(await peekEmailVerificationToken(hash(fresh), hash(PROOF))).toBe(userA)
    expect(await readEmailVerifiedAt(userA)).toBeNull()
  })

  it('resends for a live same-proof token: supersedes the prior link and mints one', async () => {
    const original = randomUUID()
    const fresh = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(original),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    const minted = await replaceEmailVerificationTokens(userA, {
      tokenHash: hash(fresh),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    // Proof continuity holds (a live same-proof token existed): mint a fresh link
    // and burn the prior same-proof one.
    expect(minted).toBe(true)
    expect(await countLiveVerificationTokens(userA)).toBe(1)
    expect(await peekEmailVerificationToken(hash(original), hash(PROOF))).toBeUndefined()
    expect(await peekEmailVerificationToken(hash(fresh), hash(PROOF))).toBe(userA)
  })

  it('mints nothing for a proof that owns no live token (griefing / no continuity)', async () => {
    const victim = randomUUID()
    const attacker = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    // The victim's real link, bound to their browser's proof.
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(victim),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    // A public resend carrying a DIFFERENT proof (an attacker who only knows the
    // email) owns no live token, so it neither burns the victim's link nor mints.
    const minted = await replaceEmailVerificationTokens(userA, {
      tokenHash: hash(attacker),
      clientProofHash: hash(OTHER_PROOF),
      expiresAt,
    })

    expect(minted).toBe(false)
    expect(await peekEmailVerificationToken(hash(victim), hash(PROOF))).toBe(userA)
    expect(await countLiveVerificationTokens(userA)).toBe(1)
    expect(await peekEmailVerificationToken(hash(attacker), hash(OTHER_PROOF))).toBeUndefined()
  })

  it('mints nothing for a stale proof whose token was consumed (no takeover)', async () => {
    const consumed = randomUUID()
    const fresh = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(consumed),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    // Simulate a competing signup that replaced the password and CONSUMED this
    // proof's token (the retry path's behaviour). The original browser still holds
    // PROOF, but it no longer owns a live token.
    await ownerPool.query(
      'UPDATE email_verification_tokens SET consumed_at = now() WHERE user_id = $1',
      [userA],
    )

    const minted = await replaceEmailVerificationTokens(userA, {
      tokenHash: hash(fresh),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    // The stale proof cannot be re-activated into a link that would verify the
    // account under the competing signup's password.
    expect(minted).toBe(false)
    expect(await countLiveVerificationTokens(userA)).toBe(0)
    expect(await peekEmailVerificationToken(hash(fresh), hash(PROOF))).toBeUndefined()
  })

  it('mints nothing once the account is verified (under-lock verified gate)', async () => {
    const original = randomUUID()
    const fresh = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    // A live same-proof token still exists, but the account is already verified.
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(original),
      clientProofHash: hash(PROOF),
      expiresAt,
    })
    await ownerPool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userA])

    const minted = await replaceEmailVerificationTokens(userA, {
      tokenHash: hash(fresh),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    // A resend must not re-introduce a live link after verification.
    expect(minted).toBe(false)
    expect(await peekEmailVerificationToken(hash(fresh), hash(PROOF))).toBeUndefined()
  })

  it('serializes against a concurrent retry: a resend racing a token-consuming retry mints nothing (no takeover)', async () => {
    await ownerPool.query(
      `UPDATE users SET password_hash = 'old-hash', email_verified_at = NULL WHERE id = $1`,
      [userA],
    )
    const original = randomUUID()
    const attacker = randomUUID()
    const fresh = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    // The victim's live link, bound to their browser's proof.
    await insertEmailVerificationToken(userA, {
      tokenHash: hash(original),
      clientProofHash: hash(PROOF),
      expiresAt,
    })

    // Hold the per-user auth_verify_email advisory lock on a separate connection
    // and apply a competing signup retry inside it (replace password, consume the
    // victim's token, mint an attacker-proof link) WITHOUT committing yet.
    const conn = await ownerPool.connect()
    try {
      await conn.query('BEGIN')
      await conn.query(
        `SELECT auth_retry_unverified_signup($1, 'old-hash', 'attacker-hash', $2, $3, $4)`,
        [userA, hash(attacker), hash(OTHER_PROOF), expiresAt],
      )

      // The resend now races and must BLOCK on the advisory lock the retry holds.
      const resendPromise = replaceEmailVerificationTokens(userA, {
        tokenHash: hash(fresh),
        clientProofHash: hash(PROOF),
        expiresAt,
      })

      // Prove serialization: the resend is waiting on an ungranted advisory lock.
      // Without the lock (the pre-fix CTE) it would never block and would observe
      // the victim's token as still-live, minting a stale-proof takeover link.
      await waitFor(async () => {
        const r = await ownerPool.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        )
        return (r.rows[0].n as number) >= 1
      })

      // Release the retry; the resend wakes, re-checks live state under the lock,
      // sees the victim's token consumed, and mints nothing.
      await conn.query('COMMIT')
      expect(await resendPromise).toBe(false)
    } finally {
      conn.release()
    }

    // No stale-proof link was re-minted; the victim's original token is gone
    // (consumed by the retry) and the resent proof cannot verify the account.
    expect(await peekEmailVerificationToken(hash(fresh), hash(PROOF))).toBeUndefined()
    expect(await peekEmailVerificationToken(hash(original), hash(PROOF))).toBeUndefined()
    expect(await readPasswordHash(userA)).toBe('attacker-hash')
  })

  it('does not replace the password after the email is verified', async () => {
    await ownerPool.query(
      `UPDATE users SET password_hash = 'old-hash', email_verified_at = now() WHERE id = $1`,
      [userA],
    )

    await expect(
      retryUnverifiedSignupWithEmailVerificationToken(userA, 'old-hash', 'new-hash', {
        tokenHash: hash(randomUUID()),
        clientProofHash: hash(PROOF),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ).resolves.toBe(false)

    expect(await readPasswordHash(userA)).toBe('old-hash')
    expect(await countLiveVerificationTokens(userA)).toBe(0)
  })
})
