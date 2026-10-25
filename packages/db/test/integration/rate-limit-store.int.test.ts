// SPDX-License-Identifier: Apache-2.0
// The Postgres rate-limit store against the REAL rate_limits table (#315).
// DATABASE_URL is the runtime role here (app_user in CI), so every consume, get
// and delete also proves the provision-roles.sql grants. Each test uses its own
// keyPrefix, so tests never share counters.
import { randomUUID } from 'node:crypto'
import { RateLimiterRes } from 'rate-limiter-flexible'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../src/client.js'
import { createPostgresRateLimiter, resetRateLimitSweeperClaim } from '../../src/rate-limit-store.js'
import { closePools, ownerPool } from './helpers.js'

const prefix = () => `t-${randomUUID()}`
// Clear the sweeper timer (only the first limiter has one) so none outlives the file.
const limiter = (keyPrefix: string, points: number, duration = 60) => {
  const l = createPostgresRateLimiter({ points, duration, keyPrefix })
  clearTimeout((l as unknown as { _clearExpiredTimeoutId?: NodeJS.Timeout })._clearExpiredTimeoutId)
  return l
}

afterAll(async () => {
  await ownerPool.query(`DELETE FROM rate_limits WHERE key LIKE 't-%'`)
  resetRateLimitSweeperClaim()
  await closeDb()
  await closePools()
})

describe('createPostgresRateLimiter (rate_limits)', () => {
  it('consumes within points and rejects the next with msBeforeNext', async () => {
    const l = limiter(prefix(), 2)
    await expect(l.consume('ip')).resolves.toMatchObject({ consumedPoints: 1 })
    await expect(l.consume('ip')).resolves.toMatchObject({ remainingPoints: 0 })
    const rejected = await l.consume('ip').catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(RateLimiterRes)
    expect((rejected as RateLimiterRes).msBeforeNext).toBeGreaterThan(0)
  })

  it('counts the same key independently under different prefixes', async () => {
    const a = limiter(prefix(), 1)
    const b = limiter(prefix(), 1)
    await a.consume('k')
    await expect(b.consume('k')).resolves.toMatchObject({ consumedPoints: 1 })
    await expect(a.consume('k')).rejects.toBeInstanceOf(RateLimiterRes)
  })

  it('resets the window after duration', async () => {
    const l = limiter(prefix(), 1, 1)
    await l.consume('k')
    await expect(l.consume('k')).rejects.toBeInstanceOf(RateLimiterRes)
    await new Promise((r) => setTimeout(r, 1100))
    await expect(l.consume('k')).resolves.toMatchObject({ consumedPoints: 1 })
  })

  it('get reports consumed points and delete clears the key', async () => {
    const l = limiter(prefix(), 5)
    await l.consume('k', 2)
    expect((await l.get('k'))?.consumedPoints).toBe(2)
    await expect(l.delete('k')).resolves.toBe(true)
    await expect(l.get('k')).resolves.toBeNull()
  })

  it('stores the row as `${keyPrefix}:${key}` in rate_limits', async () => {
    const p = prefix()
    await limiter(p, 5).consume('k')
    const r = await ownerPool.query('SELECT points, expire FROM rate_limits WHERE key = $1', [
      `${p}:k`,
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].points).toBe(1)
    expect(Number(r.rows[0].expire)).toBeGreaterThan(Date.now())
  })
})
