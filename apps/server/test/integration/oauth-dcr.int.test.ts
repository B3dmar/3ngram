// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — DCR + the full PKCE flow into /mcp (cases 1-2 of the
// matrix, plus the public-PKCE and Basic-auth
// body-shim transport extras). Shared scaffolding lives in
// oauth-conformance.helpers.ts. This is a pure split of oauth-conformance.int.test.ts;
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

describe('S4 conformance 1-2: DCR + the full PKCE flow into /mcp', () => {
  it('case 1: registers a PUBLIC client with 201 and no secret', async () => {
    const json = await ctx.registerClient('none')
    expect(typeof json.client_id).toBe('string')
    expect(json).not.toHaveProperty('client_secret')
    // RFC 7591 §3.2.1 echo — strict clients validate these against the request.
    expect(json.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(json.response_types).toEqual(['code'])
  })

  it('case 2: code -> token -> authenticated tool call through the real Bearer stack', async () => {
    const tokens = await ctx.fullFlow()
    expect(tokens.token_type).toBe('bearer')
    expect(tokens.expires_in).toBeLessThanOrEqual(3600)
    expect(tokens.scope).toBe('memory:read memory:write')
    const client = await ctx.connectMcp(tokens.access_token)
    const result = await client.callTool({ name: 'describe_environment', arguments: {} })
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  it('a PUBLIC client completes the same exchange with PKCE alone (no secret)', async () => {
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code, state } = await ctx.obtainCode(client.client_id, challenge)
    expect(state).toBe('st-123')
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

  it('honors client_secret_basic via the body shim (S4: SDK reads the body only)', async () => {
    const client = await ctx.registerClient('client_secret_basic')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const basic = Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret as string)}`,
    ).toString('base64')
    const { status } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      { authorization: `Basic ${basic}` },
    )
    expect(status).toBe(200)
  })

  it('enforces the registered method: a post-registered client cannot use Basic', async () => {
    const client = await ctx.registerClient('client_secret_post')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const basic = Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret as string)}`,
    ).toString('base64')
    const { status, json, headers } = await ctx.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      { authorization: `Basic ${basic}` },
    )
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(headers.get('www-authenticate')).toMatch(/^Basic /)
  })

  it('rejects a WRONG client_secret (post) with invalid_client and a 401', async () => {
    const client = await ctx.registerClient('client_secret_post')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const { status, json, headers } = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: 'not-the-secret',
    })
    // RFC 6749 §5.2: failed client authentication is 401; no Basic challenge
    // because the client authenticated via the body, not the Authorization header.
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(headers.get('www-authenticate')).toBeNull()
  })
})
