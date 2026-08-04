// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  assertPasswordNotBreached,
  type BreachCheckLogger,
  PasswordBreachedError,
  type PwnedRangeFetcher,
} from '../src/auth/password-breach.js'

/** SHA-1 upper-hex suffix (chars 5..) the range API would key a hit under. */
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

describe('assertPasswordNotBreached', () => {
  it('rejects a password present in the corpus', async () => {
    const password = 'hunter2hunter2'
    const fetchRange: PwnedRangeFetcher = async () => corpusHitBody(password)
    await expect(
      assertPasswordNotBreached(password, { enabled: true, fetchRange }),
    ).rejects.toBeInstanceOf(PasswordBreachedError)
  })

  it('allows a password absent from the corpus', async () => {
    const fetchRange: PwnedRangeFetcher = async () => corpusHitBody('a-different-password')
    await expect(
      assertPasswordNotBreached('s0me-unbreached-pass', { enabled: true, fetchRange }),
    ).resolves.toBeUndefined()
  })

  it('treats a zero-count corpus line as not breached (HIBP padding)', async () => {
    const password = 'padded-but-safe-pw'
    const fetchRange: PwnedRangeFetcher = async () => `${suffixOf(password)}:0`
    await expect(
      assertPasswordNotBreached(password, { enabled: true, fetchRange }),
    ).resolves.toBeUndefined()
  })

  it('is a no-op when disabled — the range API is never called', async () => {
    const fetchRange = vi.fn<PwnedRangeFetcher>()
    await expect(
      assertPasswordNotBreached('password', { enabled: false, fetchRange }),
    ).resolves.toBeUndefined()
    expect(fetchRange).not.toHaveBeenCalled()
  })

  it('sends only the 5-char SHA-1 prefix, never the password', async () => {
    const password = 'leak-check-password'
    const seen: string[] = []
    const fetchRange: PwnedRangeFetcher = async (prefix) => {
      seen.push(prefix)
      return ''
    }
    await assertPasswordNotBreached(password, { enabled: true, fetchRange })
    const expectedPrefix = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase()
      .slice(0, 5)
    expect(seen).toEqual([expectedPrefix])
    expect(seen[0]).toHaveLength(5)
    expect(seen[0]).not.toContain(password)
  })

  it('fails open when the range query rejects (timeout / unreachable)', async () => {
    const fetchRange: PwnedRangeFetcher = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(
      assertPasswordNotBreached('whatever-password', { enabled: true, fetchRange }),
    ).resolves.toBeUndefined()
  })

  it('emits a content-free warning when it fails open (observable outage)', async () => {
    const password = 'outage-pw-must-not-leak'
    const warn = vi.fn<BreachCheckLogger['warn']>()
    const fetchRange: PwnedRangeFetcher = async () => {
      throw new Error('503 from proxy')
    }
    await assertPasswordNotBreached(password, { enabled: true, fetchRange, logger: { warn } })
    expect(warn).toHaveBeenCalledTimes(1)
    const [obj, msg] = warn.mock.calls[0] ?? [{}, '']
    expect(obj).toMatchObject({ reason: 'unreachable' })
    // No password material in the counter (hard rule 6): neither the password nor
    // any SHA-1 prefix of it may appear in the logged object or message.
    const serialized = `${JSON.stringify(obj)} ${msg}`
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain(suffixOf(password).slice(0, 5))
  })

  it('classifies a timeout abort as reason "timeout"', async () => {
    const warn = vi.fn<BreachCheckLogger['warn']>()
    const fetchRange: PwnedRangeFetcher = (_prefix, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await assertPasswordNotBreached('slow-pw', {
      enabled: true,
      timeoutMs: 5,
      fetchRange,
      logger: { warn },
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: 'timeout' })
  })

  it('aborts the range query after the timeout budget and fails open', async () => {
    const fetchRange: PwnedRangeFetcher = (_prefix, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expect(
      assertPasswordNotBreached('slow-corpus-password', {
        enabled: true,
        timeoutMs: 5,
        fetchRange,
      }),
    ).resolves.toBeUndefined()
  })

  it('never logs the password (no console output on a corpus hit)', async () => {
    const password = 'do-not-log-this-pw'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchRange: PwnedRangeFetcher = async () => corpusHitBody(password)
    await expect(
      assertPasswordNotBreached(password, { enabled: true, fetchRange }),
    ).rejects.toBeInstanceOf(PasswordBreachedError)
    for (const spy of [errorSpy, logSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(password)
      }
    }
    errorSpy.mockRestore()
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
