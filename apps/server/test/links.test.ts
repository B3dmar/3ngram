// SPDX-License-Identifier: Apache-2.0
// Web-dashboard link builders: every link is built against WEB_APP_URL (the web
// origin), returns undefined when WEB_APP_URL is unset, and the reconnect link
// is the same set-password page as password reset.
import { describe, expect, it } from 'vitest'
import {
  buildReconnectLink,
  buildResetLink,
  buildSignupLink,
  buildVerificationLink,
  webOrigin,
} from '../src/links.js'

const WEB = 'https://app.3ngram.test'
const TOKEN = 'tok en/with+chars'

describe('webOrigin', () => {
  it('returns undefined when WEB_APP_URL is unset', () => {
    expect(webOrigin(undefined)).toBeUndefined()
  })

  it('strips a single trailing slash', () => {
    expect(webOrigin('https://app.3ngram.test/')).toBe('https://app.3ngram.test')
    expect(webOrigin('https://app.3ngram.test')).toBe('https://app.3ngram.test')
  })
})

describe('token link builders', () => {
  it('build reset/verification/reconnect links against the web origin with an encoded token', () => {
    expect(buildResetLink(WEB, TOKEN)).toBe(
      `${WEB}/reset-password?token=${encodeURIComponent(TOKEN)}`,
    )
    expect(buildVerificationLink(WEB, TOKEN)).toBe(
      `${WEB}/verify-email?token=${encodeURIComponent(TOKEN)}`,
    )
    expect(buildReconnectLink(WEB, TOKEN)).toBe(
      `${WEB}/reset-password?token=${encodeURIComponent(TOKEN)}`,
    )
  })

  it('reconnect link IS the reset/set-password link (migrated user lands on populated account)', () => {
    expect(buildReconnectLink(WEB, TOKEN)).toBe(buildResetLink(WEB, TOKEN))
  })

  it('return undefined when WEB_APP_URL is unset (caller skips the send)', () => {
    expect(buildResetLink(undefined, TOKEN)).toBeUndefined()
    expect(buildVerificationLink(undefined, TOKEN)).toBeUndefined()
    expect(buildReconnectLink(undefined, TOKEN)).toBeUndefined()
  })
})

describe('buildSignupLink (waitlist re-engagement, FR-014a)', () => {
  it('points at the public /signup page with no token', () => {
    expect(buildSignupLink(WEB)).toBe(`${WEB}/signup`)
  })

  it('returns undefined when WEB_APP_URL is unset', () => {
    expect(buildSignupLink(undefined)).toBeUndefined()
  })
})
