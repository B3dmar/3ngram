// SPDX-License-Identifier: Apache-2.0
// Session wrappers against the REAL runtime role (app_user, NOBYPASSRLS) —
// owner bypasses RLS and would prove nothing (docs/concepts/testing.mdx). Covers the
// SECURITY DEFINER resolve path, the withTenant() INSERT path, expiry
// filtering, and that a tenant cannot forge a session for another user.
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertPasswordResetToken, resetPasswordAtomic } from '../../src/auth-reset-tokens.js'
import {
  insertSession,
  resolveSession,
  rotatePasswordAndRevokeOthers,
} from '../../src/auth-sessions.js'
import { closeDb } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

let userA: string
let userB: string

beforeAll(async () => {
  userA = await seedUser('sess-a@test.local')
  userB = await seedUser('sess-b@test.local')
})

let userRotate: string
let userCasMiss: string
let userRace: string

beforeAll(async () => {
  userRotate = await seedUser('sess-rotate@test.local')
  userCasMiss = await seedUser('sess-casmiss@test.local')
  userRace = await seedUser('sess-race@test.local')
})

afterAll(async () => {
  const ids = [userA, userB, userRotate, userCasMiss, userRace]
  await ownerPool.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1)', [ids])
  await ownerPool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [ids])
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [
    [userRotate, userCasMiss, userRace],
  ])
  await closeDb()
  await closePools()
})

/** Count a user's still-unconsumed reset tokens via the owner pool. */
async function countLiveResetTokens(userId: string): Promise<number> {
  const r = await ownerPool.query(
    'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL',
    [userId],
  )
  return r.rows[0].n as number
}

/** Read a user's current password_hash via the owner pool (bypasses RLS for assertions). */
async function readPasswordHash(userId: string): Promise<string> {
  const r = await ownerPool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
  return r.rows[0].password_hash as string
}

/** Count a user's live sessions via the owner pool. */
async function countSessions(userId: string): Promise<number> {
  const r = await ownerPool.query(
    'SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1',
    [userId],
  )
  return r.rows[0].n as number
}

describe('auth-sessions (runtime role, real withTenant + SECURITY DEFINER)', () => {
  it('inserts a session and resolves it back to its owner', async () => {
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertSession(userA, hash(token), expiresAt)

    const resolved = await resolveSession(hash(token))
    expect(resolved?.userId).toBe(userA)
    expect(resolved?.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -3)
  })

  it('returns undefined for an unknown token hash', async () => {
    expect(await resolveSession(hash(randomUUID()))).toBeUndefined()
  })

  it('does not resolve an expired session (resolver filters expires_at > now)', async () => {
    const token = randomUUID()
    await insertSession(userA, hash(token), new Date(Date.now() - 1000))
    expect(await resolveSession(hash(token))).toBeUndefined()
  })

  it('rejects a forged session for another user (RLS WITH CHECK on the INSERT)', async () => {
    // insertSession binds tenant = userB but writes user_id = userA: the
    // user_sessions WITH CHECK must reject it. Driven via the wrapper would
    // pass matching ids, so this asserts the policy directly through withTenant.
    const { withTenant } = await import('../../src/client.js')
    const { sql } = await import('drizzle-orm')
    await expect(
      withTenant(userB, (tx) =>
        tx.execute(
          sql`INSERT INTO user_sessions (user_id, token_hash, expires_at)
              VALUES (${userA}, ${hash(randomUUID())}, now() + interval '1 hour')`,
        ),
      ),
    ).rejects.toSatisfy((e: Error) =>
      /row-level security/.test(String((e as { cause?: unknown }).cause ?? e)),
    )
  })
})

describe('rotatePasswordAndRevokeOthers (single-tx atomicity, #279 P2)', () => {
  it('rotates the hash AND revokes other sessions in one tx, keeping the current one', async () => {
    // seedUser stores password_hash = 'x'. Two live sessions: keep is the
    // requester, drop is another device.
    const keepToken = randomUUID()
    const dropToken = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertSession(userRotate, hash(keepToken), expiresAt)
    await insertSession(userRotate, hash(dropToken), expiresAt)
    expect(await countSessions(userRotate)).toBe(2)

    const ok = await rotatePasswordAndRevokeOthers(userRotate, 'x', 'new-hash', hash(keepToken))
    expect(ok).toBe(true)

    // Password rotated AND only the kept session survives — both writes committed.
    expect(await readPasswordHash(userRotate)).toBe('new-hash')
    expect(await resolveSession(hash(keepToken))).toBeDefined()
    expect(await resolveSession(hash(dropToken))).toBeUndefined()
    expect(await countSessions(userRotate)).toBe(1)
  })

  it('also burns the user outstanding reset tokens in the same tx (full-delta review P2)', async () => {
    // The user requested a reset link, then changes their password from Account.
    // The stale link must not survive as a takeover credential.
    const keepToken = randomUUID()
    const resetToken = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertSession(userRotate, hash(keepToken), expiresAt)
    await insertPasswordResetToken(userRotate, { tokenHash: hash(resetToken), expiresAt })
    expect(await countLiveResetTokens(userRotate)).toBe(1)

    // seedUser left password_hash = 'new-hash' from the prior test; rotate again.
    const ok = await rotatePasswordAndRevokeOthers(
      userRotate,
      'new-hash',
      'newer-hash',
      hash(keepToken),
    )
    expect(ok).toBe(true)
    // The outstanding reset link is now burned.
    expect(await countLiveResetTokens(userRotate)).toBe(0)
  })

  it('a stale current hash (CAS miss) rolls BOTH writes back: password and sessions unchanged', async () => {
    // Atomicity proof without fault injection: a wrong expectedHash makes the
    // in-tx UPDATE match zero rows, so the whole tx aborts. The password must
    // stay 'x' AND every session must survive — neither write may leak through.
    const sessionToken = randomUUID()
    const resetToken = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await insertSession(userCasMiss, hash(sessionToken), expiresAt)
    await insertPasswordResetToken(userCasMiss, { tokenHash: hash(resetToken), expiresAt })
    expect(await countSessions(userCasMiss)).toBe(1)
    expect(await countLiveResetTokens(userCasMiss)).toBe(1)

    const ok = await rotatePasswordAndRevokeOthers(
      userCasMiss,
      'wrong-current-hash',
      'should-not-be-written',
      hash(randomUUID()), // a keep hash that matches nothing → would delete the live session if it ran
    )
    expect(ok).toBe(false)

    // All three writes rolled back: password untouched, session AND reset token live.
    expect(await readPasswordHash(userCasMiss)).toBe('x')
    expect(await countSessions(userCasMiss)).toBe(1)
    expect(await resolveSession(hash(sessionToken))).toBeDefined()
    expect(await countLiveResetTokens(userCasMiss)).toBe(1)
  })

  it('a change-password racing a reset for the same user does NOT deadlock (full-delta review P2)', async () => {
    // The reset resolver locks token-row then users-row; this path locks
    // users-row then token-rows. Without the shared per-user advisory lock the
    // two orders form a cycle and Postgres aborts one tx with 40P01. Both paths
    // now take the SAME advisory key first, so they serialize: exactly one
    // password operation takes effect, the reset token ends consumed, and
    // NEITHER call rejects with a deadlock.
    const keepToken = randomUUID()
    const resetToken = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await ownerPool.query("UPDATE users SET password_hash = 'H0' WHERE id = $1", [userRace])
    await insertSession(userRace, hash(keepToken), expiresAt)
    await insertPasswordResetToken(userRace, { tokenHash: hash(resetToken), expiresAt })

    // Run both on different pooled connections so they genuinely race.
    const [chg, rst] = await Promise.allSettled([
      rotatePasswordAndRevokeOthers(userRace, 'H0', 'H_CHANGE', hash(keepToken)),
      resetPasswordAtomic(hash(resetToken), 'H_RESET'),
    ])

    // No 40P01: neither call may reject (a deadlock would surface as a rejection).
    expect(chg.status).toBe('fulfilled')
    expect(rst.status).toBe('fulfilled')
    // Exactly one password operation took effect; the other no-ops (CAS miss or
    // a token already burned). The final hash is one of the two, never partial.
    expect(['H_CHANGE', 'H_RESET']).toContain(await readPasswordHash(userRace))
    // Either way the reset token is dead (burned by the change-password, or
    // consumed by the reset itself).
    expect(await countLiveResetTokens(userRace)).toBe(0)
  })
})
