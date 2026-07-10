// SPDX-License-Identifier: Apache-2.0
// Atomic password-reset resolver (migrations/0016 auth_reset_password)
// against the REAL runtime role (app_user, NOBYPASSRLS) — the owner bypasses RLS
// and would prove nothing (docs/concepts/testing.mdx). Proves the account-takeover hardening:
// a successful reset consumes the presented token, rotates the password, revokes
// EVERY session, and burns EVERY other outstanding reset token for that user, in
// ONE serialized transaction. Exactly one of two concurrent resets can take
// effect; the sibling — whether a late-arriving link or a near-simultaneous race
// — is dead. A second user's token MUST be untouched (the purge is tenant-scoped).
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  insertPasswordResetToken,
  peekResetToken,
  resetPasswordAtomic,
} from '../../src/auth-reset-tokens.js'
import { closeDb } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000)

let userA: string
let userB: string

beforeAll(async () => {
  userA = await seedUser('reset-atomic-a@test.local')
  userB = await seedUser('reset-atomic-b@test.local')
})

beforeEach(async () => {
  // Clear any tokens/sessions a prior test left and reset both hashes to a known
  // sentinel so each test starts from a deterministic password.
  await ownerPool.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1)', [
    [userA, userB],
  ])
  await ownerPool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query("UPDATE users SET password_hash = 'H0' WHERE id = ANY($1)", [
    [userA, userB],
  ])
})

afterAll(async () => {
  const ids = [userA, userB]
  await ownerPool.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1)', [ids])
  await ownerPool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [ids])
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [ids])
  await closeDb()
  await closePools()
})

/** Read a user's current password hash (owner, bypasses RLS for the assertion). */
async function currentHash(userId: string): Promise<string | undefined> {
  const r = await ownerPool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
  return r.rows[0]?.password_hash
}

/** Count the user's still-unconsumed reset tokens. */
async function liveTokenCount(userId: string): Promise<number> {
  const r = await ownerPool.query(
    'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL',
    [userId],
  )
  return r.rows[0].n
}

describe('auth_reset_password — account-takeover hardening (issue #267)', () => {
  it('a successful reset rotates the password, revokes ALL sessions, and burns ALL siblings', async () => {
    // The user requested a reset twice → two live tokens, plus two live sessions.
    const tokenA = randomUUID()
    const tokenB = randomUUID()
    await insertPasswordResetToken(userA, { tokenHash: hash(tokenA), expiresAt: inAnHour() })
    await insertPasswordResetToken(userA, { tokenHash: hash(tokenB), expiresAt: inAnHour() })
    await ownerPool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3),($1,$4,$3)`,
      [userA, hash('sess-1'), inAnHour(), hash('sess-2')],
    )

    const ownerId = await resetPasswordAtomic(hash(tokenA), 'H_A')
    expect(ownerId).toBe(userA)
    expect(await currentHash(userA)).toBe('H_A') // rotated
    expect(await liveTokenCount(userA)).toBe(0) // A consumed + sibling B burned
    const sessions = await ownerPool.query(
      'SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1',
      [userA],
    )
    expect(sessions.rows[0].n).toBe(0) // every session revoked
  })

  it('the sibling link is DEAD afterwards: a later reset with token B does nothing (the takeover vector)', async () => {
    // This is exactly the vector the old consume→read→rotate split lost: a second
    // live link, presented AFTER the first reset committed, would read the fresh
    // hash and re-rotate. Under the atomic resolver, B was burned by A's reset, so
    // presenting it now resolves to no user and the password stays the winner's.
    const tokenA = randomUUID()
    const tokenB = randomUUID()
    await insertPasswordResetToken(userA, { tokenHash: hash(tokenA), expiresAt: inAnHour() })
    await insertPasswordResetToken(userA, { tokenHash: hash(tokenB), expiresAt: inAnHour() })

    expect(await resetPasswordAtomic(hash(tokenA), 'H_A')).toBe(userA)
    // B is the attacker's still-held sibling link.
    expect(await resetPasswordAtomic(hash(tokenB), 'H_ATTACKER')).toBeUndefined()
    expect(await currentHash(userA)).toBe('H_A') // NOT H_ATTACKER — no takeover
  })

  it('two concurrent resets for the same user: exactly one wins, no deadlock, sibling dead', async () => {
    // A third never-presented token C must also be burned by the winner.
    const tokenA = randomUUID()
    const tokenB = randomUUID()
    const tokenC = randomUUID()
    for (const t of [tokenA, tokenB, tokenC]) {
      await insertPasswordResetToken(userA, { tokenHash: hash(t), expiresAt: inAnHour() })
    }

    // Both calls go through the runtime (app_user) pool on different connections,
    // so they genuinely race on the per-user advisory lock.
    const [rA, rB] = await Promise.allSettled([
      resetPasswordAtomic(hash(tokenA), 'H_A'),
      resetPasswordAtomic(hash(tokenB), 'H_B'),
    ])

    // Neither call may reject — a 40P01 deadlock here would mean the advisory
    // lock was removed and the lock-free sibling-burn/users-UPDATE cycle returned.
    expect(rA.status).toBe('fulfilled')
    expect(rB.status).toBe('fulfilled')
    const results = [
      rA.status === 'fulfilled' ? rA.value : undefined,
      rB.status === 'fulfilled' ? rB.value : undefined,
    ]
    const winners = results.filter((v) => v === userA)
    const losers = results.filter((v) => v === undefined)
    expect(winners).toHaveLength(1) // exactly one reset took effect
    expect(losers).toHaveLength(1) // the other lost the race

    const finalHash = await currentHash(userA)
    expect(['H_A', 'H_B']).toContain(finalHash) // the winner's, never partial
    expect(await liveTokenCount(userA)).toBe(0) // A, B, AND the unpresented C all burned
  })

  it("does NOT touch another user's outstanding reset token (purge is tenant-scoped)", async () => {
    const tokenA = randomUUID()
    const tokenB = randomUUID() // belongs to user B, an unrelated account
    await insertPasswordResetToken(userA, { tokenHash: hash(tokenA), expiresAt: inAnHour() })
    await insertPasswordResetToken(userB, { tokenHash: hash(tokenB), expiresAt: inAnHour() })

    expect(await resetPasswordAtomic(hash(tokenA), 'H_A')).toBe(userA)

    // User B never reset: their token must still be live and usable.
    expect(await liveTokenCount(userB)).toBe(1)
    expect(await resetPasswordAtomic(hash(tokenB), 'H_B')).toBe(userB)
    expect(await currentHash(userB)).toBe('H_B')
  })

  it('peekResetToken is read-only: returns the owner for a live token, undefined otherwise, never consuming', async () => {
    const live = randomUUID()
    await insertPasswordResetToken(userA, { tokenHash: hash(live), expiresAt: inAnHour() })

    // A live token peeks to its owner — and stays live (peek must not consume).
    expect(await peekResetToken(hash(live))).toBe(userA)
    expect(await peekResetToken(hash(live))).toBe(userA)
    expect(await liveTokenCount(userA)).toBe(1)

    // Unknown / expired peek to undefined.
    expect(await peekResetToken(hash(randomUUID()))).toBeUndefined()
    const expired = randomUUID()
    await insertPasswordResetToken(userA, {
      tokenHash: hash(expired),
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await peekResetToken(hash(expired))).toBeUndefined()

    // After a real reset consumes it, the peek goes undefined.
    expect(await resetPasswordAtomic(hash(live), 'H_A')).toBe(userA)
    expect(await peekResetToken(hash(live))).toBeUndefined()
  })

  it('an unknown, expired, or already-consumed token resolves to no user (no write)', async () => {
    // unknown
    expect(await resetPasswordAtomic(hash(randomUUID()), 'H_X')).toBeUndefined()
    // expired
    const expired = randomUUID()
    await insertPasswordResetToken(userA, {
      tokenHash: hash(expired),
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await resetPasswordAtomic(hash(expired), 'H_X')).toBeUndefined()
    expect(await currentHash(userA)).toBe('H0') // untouched

    // already-consumed (replay)
    const once = randomUUID()
    await insertPasswordResetToken(userA, { tokenHash: hash(once), expiresAt: inAnHour() })
    expect(await resetPasswordAtomic(hash(once), 'H_A')).toBe(userA)
    expect(await resetPasswordAtomic(hash(once), 'H_REPLAY')).toBeUndefined()
    expect(await currentHash(userA)).toBe('H_A')
  })
})
