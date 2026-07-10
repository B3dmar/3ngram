// SPDX-License-Identifier: Apache-2.0
// Mailer SMTP-OPTIONAL contract. Two behaviors are proven
// with NO real network: a MOCK transport is injected for the configured path,
// and the disabled path is exercised by returning undefined config. The mailer
// must DEGRADE (never throw) when SMTP is off OR when the transport rejects, so
// the forgot-password route can always answer a uniform 200 (no user enumeration).
import type { SmtpConfig } from '@3ngram/config'
import { describe, expect, it, vi } from 'vitest'
import {
  isMailerConfigured,
  type MailTransport,
  sendMigrationEmail,
  sendReengagementEmail,
  sendResetEmail,
  sendVerificationEmail,
} from '../src/mailer.js'

const CONFIG: SmtpConfig = {
  host: 'smtp.example.test',
  port: 587,
  from: 'no-reply@3ngram.test',
  auth: { user: 'mailer', pass: 'secret-pass' },
}

/** A mock transport that records the message and reports the captured call. */
function mockTransport(): { transport: MailTransport; sendMail: ReturnType<typeof vi.fn> } {
  const sendMail = vi.fn(async () => ({ messageId: '<mock-id@3ngram.test>' }))
  return { transport: { sendMail }, sendMail }
}

describe('sendResetEmail — SMTP not configured (degraded path)', () => {
  it('returns delivered:false with smtp-not-configured and never throws', async () => {
    const result = await sendResetEmail('user@example.test', 'https://3ngram.test/reset?t=abc', {
      loadConfig: () => undefined,
    })
    expect(result).toEqual({ delivered: false, reason: 'smtp-not-configured' })
  })

  it('does NOT build a transport when SMTP is absent', async () => {
    const factory = vi.fn()
    await sendResetEmail('user@example.test', 'https://3ngram.test/reset?t=abc', {
      loadConfig: () => undefined,
      transportFactory: factory,
    })
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('sendResetEmail — SMTP configured (enabled path, mock transport)', () => {
  it('sends via the mock transport and returns the message id', async () => {
    const { transport, sendMail } = mockTransport()
    const result = await sendResetEmail('user@example.test', 'https://3ngram.test/reset?t=abc', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: true, messageId: '<mock-id@3ngram.test>' })
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('uses the configured from-address, the recipient, and embeds the reset link', async () => {
    const { transport, sendMail } = mockTransport()
    await sendResetEmail('user@example.test', 'https://3ngram.test/reset?t=token-123', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    const message = sendMail.mock.calls[0]?.[0] as {
      from: string
      to: string
      subject: string
      text: string
    }
    expect(message.from).toBe('no-reply@3ngram.test')
    expect(message.to).toBe('user@example.test')
    expect(message.subject).toContain('Reset')
    expect(message.text).toContain('https://3ngram.test/reset?t=token-123')
  })

  it('degrades (delivered:false send-failed) when the transport rejects — no throw', async () => {
    const transport: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    }
    const result = await sendResetEmail('user@example.test', 'https://3ngram.test/reset?t=abc', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: false, reason: 'send-failed' })
  })
})

describe('sendVerificationEmail — SMTP configured (enabled path, mock transport)', () => {
  it('uses the verification subject and embeds the verification link', async () => {
    const { transport, sendMail } = mockTransport()
    const result = await sendVerificationEmail(
      'user@example.test',
      'https://3ngram.test/verify-email?t=token-123',
      {
        loadConfig: () => CONFIG,
        transportFactory: () => transport,
      },
    )

    expect(result).toEqual({ delivered: true, messageId: '<mock-id@3ngram.test>' })
    const message = sendMail.mock.calls[0]?.[0] as {
      from: string
      to: string
      subject: string
      text: string
    }
    expect(message.from).toBe('no-reply@3ngram.test')
    expect(message.to).toBe('user@example.test')
    expect(message.subject).toContain('Verify')
    expect(message.text).toContain('https://3ngram.test/verify-email?t=token-123')
  })
})

describe('sendMigrationEmail — legacy-migration reconnect (spec 006 FR-012)', () => {
  it('degrades (never throws) when SMTP is not configured', async () => {
    const result = await sendMigrationEmail(
      'user@example.test',
      'https://3ngram.test/reset?t=reconnect-1',
      { loadConfig: () => undefined },
    )
    expect(result).toEqual({ delivered: false, reason: 'smtp-not-configured' })
  })

  it('uses the migration subject and embeds the reconnect link', async () => {
    const { transport, sendMail } = mockTransport()
    const result = await sendMigrationEmail(
      'user@example.test',
      'https://3ngram.test/reset?t=reconnect-1',
      { loadConfig: () => CONFIG, transportFactory: () => transport },
    )
    expect(result).toEqual({ delivered: true, messageId: '<mock-id@3ngram.test>' })
    const message = sendMail.mock.calls[0]?.[0] as { to: string; subject: string; text: string }
    expect(message.to).toBe('user@example.test')
    expect(message.subject).toContain('memory')
    expect(message.text).toContain('https://3ngram.test/reset?t=reconnect-1')
  })

  it('embeds the caller-built WEB_APP_URL reconnect link verbatim (contract test 1)', async () => {
    // The reconnect link is built by the caller from WEB_APP_URL + the existing
    // set-password token flow (see migrationBody / mailer.ts:94-96); the mailer
    // must embed it UNMODIFIED so it lands on the pre-provisioned populated
    // account. This proves "built with WEB_APP_URL" at the boundary the mailer
    // owns (verbatim pass-through), rather than assuming it.
    const webAppUrl = 'https://app.3ngram.test'
    const reconnectLink = `${webAppUrl}/set-password?token=reconnect-xyz`
    const { transport, sendMail } = mockTransport()
    const result = await sendMigrationEmail('user@example.test', reconnectLink, {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: true, messageId: '<mock-id@3ngram.test>' })
    const message = sendMail.mock.calls[0]?.[0] as { text: string }
    expect(message.text).toContain(reconnectLink)
    expect(message.text).toContain(webAppUrl)
  })

  it('degrades (send-failed) when the transport rejects — no throw', async () => {
    const transport: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    }
    const result = await sendMigrationEmail('user@example.test', 'https://3ngram.test/reset?t=x', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: false, reason: 'send-failed' })
  })
})

describe('sendReengagementEmail — waitlist self-serve invite (spec 006 FR-014a)', () => {
  it('embeds the public signup link, not a reset/account link', async () => {
    const { transport, sendMail } = mockTransport()
    await sendReengagementEmail('lead@example.test', 'https://3ngram.test/signup', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    const message = sendMail.mock.calls[0]?.[0] as { to: string; subject: string; text: string }
    expect(message.to).toBe('lead@example.test')
    expect(message.text).toContain('https://3ngram.test/signup')
    expect(message.text).not.toContain('/reset')
  })

  it('delivers via the mock transport with a verbatim WEB_APP_URL signup link', async () => {
    // The signup link is the public self-serve URL built from WEB_APP_URL by the
    // caller; the mailer embeds it unmodified and never points at a reset/account
    // link (it provisions no account).
    const webAppUrl = 'https://app.3ngram.test'
    const signupLink = `${webAppUrl}/signup`
    const { transport, sendMail } = mockTransport()
    const result = await sendReengagementEmail('lead@example.test', signupLink, {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: true, messageId: '<mock-id@3ngram.test>' })
    const message = sendMail.mock.calls[0]?.[0] as { subject: string; text: string }
    expect(message.subject).toContain('3ngram')
    expect(message.text).toContain(signupLink)
    expect(message.text).not.toContain('/reset')
  })

  it('degrades (never throws) when SMTP is not configured', async () => {
    const result = await sendReengagementEmail('lead@example.test', 'https://3ngram.test/signup', {
      loadConfig: () => undefined,
    })
    expect(result).toEqual({ delivered: false, reason: 'smtp-not-configured' })
  })

  it('degrades (send-failed) when the transport rejects — no throw', async () => {
    const transport: MailTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    }
    const result = await sendReengagementEmail('lead@example.test', 'https://3ngram.test/signup', {
      loadConfig: () => CONFIG,
      transportFactory: () => transport,
    })
    expect(result).toEqual({ delivered: false, reason: 'send-failed' })
  })
})

describe('isMailerConfigured', () => {
  it('is false when config resolves to undefined', () => {
    expect(isMailerConfigured(() => undefined)).toBe(false)
  })

  it('is true when SMTP config is present', () => {
    expect(isMailerConfigured(() => CONFIG)).toBe(true)
  })
})
