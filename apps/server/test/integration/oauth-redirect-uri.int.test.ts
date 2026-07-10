// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — redirect_uri exact match (cases 3-4: no redirect on
// failure) and single-use codes + PKCE (cases 5-6), plus the token-time
// redirect_uri binding (omit permitted under mismatch-only, differ rejected).
// Shared scaffolding lives in oauth-conformance.helpers.ts. Pure split of
// oauth-conformance.int.test.ts; no behavior or assertion
// changes.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type OAuthConformanceContext,
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

describe('S4 conformance 3-4: redirect_uri exact match (no redirect on failure)', () => {
  it.each([
    ['case 3: path suffix', `${REDIRECT_URI}/extra`],
    ['case 4: query suffix', `${REDIRECT_URI}?extra=1`],
  ])('%s is rejected with a DIRECT 400 (never a redirect)', async (_label, redirectUri) => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const page = await fetch(
      `${ctx.baseUrl}/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
      { redirect: 'manual' },
    )
    expect(page.status).toBe(400)
  })
})

describe('S4 conformance 5-6: single-use codes + PKCE', () => {
  it('case 5: a replayed code is rejected (atomic consume)', async () => {
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const exchange = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
    }
    const first = await ctx.tokenRequest(exchange)
    expect(first.status).toBe(200)
    const replay = await ctx.tokenRequest(exchange)
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
  })

  it('case 6: a PKCE verifier mismatch is rejected AND burns the code', async () => {
    const client = await ctx.registerClient('none')
    const { challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const wrong = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: randomBytes(32).toString('base64url'),
      client_id: client.client_id,
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error).toBe('invalid_grant')
    // Consume-then-verify: the correct verifier can no longer redeem the code.
    const { verifier } = pkcePair()
    const retry = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
    })
    expect(retry.status).toBe(400)
  })

  it('PERMITS an OMITTED redirect_uri at token when it was OMITTED at authorize (RFC 6749 §4.1.3)', async () => {
    // The single-registered-URI flow lets a client OMIT redirect_uri at
    // /authorize; the stored value is the RESOLVED one (redirect_uri_supplied =
    // false), so omitting it at token is permitted and tokens mint.
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(
      client.client_id,
      challenge,
      {},
      { omitRedirectUri: true },
    )
    const omitted = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      // redirect_uri omitted at BOTH authorize and token — permitted.
      client_id: client.client_id,
    })
    expect(omitted.status).toBe(200)
    expect(typeof omitted.json.access_token).toBe('string')
  })

  it('CONSENT FORM: omitted-at-authorize stays redirect_uri_supplied=false even though the form re-submits the resolved URI (issue #182)', async () => {
    // Regression for the consent-form leak: when the client OMITS redirect_uri at
    // GET /authorize, the rendered form embeds the RESOLVED URI as a hidden field,
    // so a faithful browser POST ALWAYS carries redirect_uri. Deriving supplied-ness
    // from the POST's redirect_uri presence wrongly marks the grant as supplied,
    // which would REQUIRE redirect_uri at token. Here we drive the REAL form fields
    // and assert a later token request that OMITS redirect_uri is PERMITTED.
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    // redirect_uri intentionally OMITTED at /authorize (single registered URI).
    const page = await ctx.getConsentPage({
      client_id: client.client_id,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-form',
    })
    expect(page.status).toBe(200)
    expect(page.csrfCookie).toBeDefined()
    // The form DOES re-submit the resolved redirect_uri (the whole trap)...
    expect(page.hiddenFields.redirect_uri).toBe(REDIRECT_URI)
    // ...but must NOT carry the supplied marker, because the client omitted it.
    expect(page.hiddenFields.redirect_uri_was_supplied).toBeUndefined()

    const consent = await ctx.submitConsent(
      { ...page.hiddenFields, email: ctx.email, password: PASSWORD },
      page.csrfCookie as string,
    )
    expect(consent.status).toBe(302)
    const code = new URL(consent.headers.get('location') as string).searchParams.get(
      'code',
    ) as string

    // redirect_uri omitted at token — PERMITTED because it was omitted at authorize.
    const omitted = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
    })
    expect(omitted.status).toBe(200)
    expect(typeof omitted.json.access_token).toBe('string')
  })

  it('REJECTS an OMITTED redirect_uri at token when it was SUPPLIED at authorize (RFC 6749 §4.1.3)', async () => {
    // obtainCode sends redirect_uri at /authorize (redirect_uri_supplied =
    // true), so RFC 6749 §4.1.3 REQUIRES it at token — omitting it is
    // invalid_grant and the burned code cannot be retried.
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const omitted = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      // redirect_uri intentionally omitted though it was supplied at authorize.
      client_id: client.client_id,
    })
    expect(omitted.status).toBe(400)
    expect(omitted.json.error).toBe('invalid_grant')
    expect(omitted.json.access_token).toBeUndefined()
  })

  it('PERMITS a MATCHING redirect_uri at token when it was SUPPLIED at authorize (RFC 6749 §4.1.3)', async () => {
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const matched = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
    })
    expect(matched.status).toBe(200)
    expect(typeof matched.json.access_token).toBe('string')
  })

  it('rejects a token exchange whose redirect_uri DIFFERS from the one bound at authorize', async () => {
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const mismatch = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: `${REDIRECT_URI}/extra`,
      client_id: client.client_id,
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.json.error).toBe('invalid_grant')
    expect(mismatch.json.access_token).toBeUndefined()
  })
})
