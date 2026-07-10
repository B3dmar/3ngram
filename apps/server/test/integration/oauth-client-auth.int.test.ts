// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — token-endpoint client authentication matrix
// (RFC 6749 §2.3.1 / §3.2.1): Basic-only, Basic + matching/conflicting posted
// client_id, client_secret_post, missing secret, public client_id-only, malformed
// Basic, and registered-method enforcement. Shared scaffolding lives in
// oauth-conformance.helpers.ts. Pure split of oauth-conformance.int.test.ts;
// no behavior or assertion changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type OAuthConformanceContext,
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

describe('token-endpoint client authentication (RFC 6749 §2.3.1 / §3.2.1)', () => {
  const basicHeader = (clientId: string, clientSecret: string): string =>
    `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`

  it('authenticates a Basic-only confidential client (no posted client_id)', async () => {
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      { authorization: basicHeader(client.client_id, client.client_secret as string) },
    )
    expect(status).toBe(200)
    expect(typeof json.access_token).toBe('string')
  })

  it('authenticates Basic + a MATCHING posted client_id (the §3.2.1 regression)', async () => {
    // RFC 6749 §3.2.1 permits a client to also send client_id as a form
    // parameter; the shim must still decode Basic instead of skipping it.
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
      },
      { authorization: basicHeader(client.client_id, client.client_secret as string) },
    )
    expect(status).toBe(200)
    expect(typeof json.access_token).toBe('string')
  })

  it('rejects Basic + a CONFLICTING posted client_id with invalid_client', async () => {
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json, headers } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: 'a-different-client-id',
      },
      { authorization: basicHeader(client.client_id, client.client_secret as string) },
    )
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(headers.get('www-authenticate')).toMatch(/^Basic /)
    expect(json.access_token).toBeUndefined()
  })

  it('authenticates a client_secret_post confidential client', async () => {
    const client = await ctx.registerClient('client_secret_post')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret as string,
    })
    expect(status).toBe(200)
    expect(typeof json.access_token).toBe('string')
  })

  it('rejects a confidential client presenting NO secret with invalid_client', async () => {
    const client = await ctx.registerClient('client_secret_post')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json, headers } = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      // client_secret omitted — a confidential client may not authenticate as public.
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    // No Basic header was presented, so no Basic challenge is offered.
    expect(headers.get('www-authenticate')).toBeNull()
  })

  it('lets a public client (registered none) authenticate with client_id only (PKCE enforced)', async () => {
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
    })
    expect(status).toBe(200)
    expect(typeof json.access_token).toBe('string')
  })

  it('rejects a malformed Basic header (no colon) with invalid_client', async () => {
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      { authorization: `Basic ${Buffer.from('no-colon-here').toString('base64')}` },
    )
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(json.access_token).toBeUndefined()
  })

  it('enforces the registered method: a Basic-registered client cannot use post', async () => {
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json } = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret as string,
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
  })
})
