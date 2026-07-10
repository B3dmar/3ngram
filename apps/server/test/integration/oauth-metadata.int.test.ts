// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — discovery metadata (cases 13-14: RFC 8414 AS metadata
// + RFC 9728 protected-resource metadata, issuer matching RS discovery exactly)
// and the consent transport guards (CSRF gate, wrong-credential
// re-render, no orphan session on consent, and the consent-form rendering of
// client name / redirect host / requested scopes). Shared scaffolding lives in
// oauth-conformance.helpers.ts. Pure split of oauth-conformance.int.test.ts;
// no behavior or assertion changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_ISSUER, TEST_RESOURCE } from '../oauth-token-helper.js'
import {
  type OAuthConformanceContext,
  ownerPool,
  PASSWORD,
  pkcePair,
  REDIRECT_URI,
  setupConformance,
} from './oauth-conformance.helpers.js'

let ctx: OAuthConformanceContext
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ ctx, teardown } = await setupConformance())
})

afterAll(async () => {
  await teardown()
})

describe('S4 conformance 13-14: discovery', () => {
  it('case 13: serves RFC 8414 AS metadata with the issuer matching RS discovery EXACTLY', async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.issuer).toBe(TEST_ISSUER)
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
  })

  it('case 14: serves RFC 9728 protected-resource metadata naming the same issuer', async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe(TEST_RESOURCE)
    expect(body.authorization_servers).toEqual([TEST_ISSUER])
  })
})

describe('consent transport guards', () => {
  it('rejects a consent POST whose csrf_token does not match the cookie (403)', async () => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const query = {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }
    const page = await ctx.getConsentPage(query)
    expect(page.status).toBe(200)
    const res = await ctx.submitConsent(
      { ...query, email: ctx.email, password: PASSWORD, csrf_token: 'forged-token' },
      page.csrfCookie as string,
    )
    expect(res.status).toBe(403)
  })

  it('re-renders the form with 401 on wrong credentials — no code is issued', async () => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const query = {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }
    const page = await ctx.getConsentPage(query)
    const res = await ctx.submitConsent(
      {
        ...query,
        email: ctx.email,
        password: 'definitely-wrong',
        csrf_token: page.csrfToken as string,
      },
      page.csrfCookie as string,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('form')
  })

  it('issues a code on consent WITHOUT minting a sessions row (#165 A2: verify, not login)', async () => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const before = await ownerPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
      [ctx.email],
    )
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    expect(typeof code).toBe('string')
    const after = await ownerPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
      [ctx.email],
    )
    // Consent confirms identity via verifyCredentials, not login — so the
    // user's session count is unchanged (no orphan session left behind).
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
  })

  it('shows the client name, redirect host, and requested scopes on the form', async () => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const res = await fetch(
      `${ctx.baseUrl}/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'memory:read',
      })}`,
    )
    const html = await res.text()
    expect(html).toContain('Conformance Client')
    expect(html).toContain('client.example')
    expect(html).toContain('memory:read')
    expect(html).not.toContain('memory:write')
  })
})
