// SPDX-License-Identifier: Apache-2.0
// Client ID Metadata Document OAuth flow against the real DB/provider stack.
// The metadata fetch seam is injected, so CI performs no external network I/O;
// the production resolver's DNS pinning/HTTP bounds are covered in core tests.
import { ClientMetadataResolver } from '@3ngram/core/auth'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type OAuthConformanceContext,
  ownerPool,
  pkcePair,
  REDIRECT_URI,
  setupConformance,
  type TokenSet,
} from './oauth-conformance.helpers.js'

const CLIENT_ID = `https://client.example.test/oauth/metadata.json?instance=${crypto.randomUUID()}`
const fetchDocument = vi.fn(async () => ({
  document: {
    client_id: CLIENT_ID,
    client_name: 'CIMD Conformance Client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  },
  headers: new Headers({ 'cache-control': 'public, max-age=60' }),
}))

let ctx: OAuthConformanceContext
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ ctx, teardown } = await setupConformance({
    clientMetadataResolver: new ClientMetadataResolver({ fetchDocument }),
  }))
})

afterAll(async () => {
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [CLIENT_ID])
  await teardown()
})

describe('CIMD OAuth compatibility', () => {
  it('advertises CIMD while retaining the DCR fallback endpoint', async () => {
    const response = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`)
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata.client_id_metadata_document_supported).toBe(true)
    expect(metadata.registration_endpoint).toBe('https://api.3ngram.test/oauth/register')
  })

  it('shows the client metadata host on the consent page', async () => {
    const { challenge } = pkcePair()
    const page = await ctx.getConsentPage({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    expect(page.status).toBe(200)
    expect(page.html).toContain('metadata from client.example.test')
  })

  it('completes authorization, token exchange, and refresh as a public CIMD client', async () => {
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(CLIENT_ID, challenge)
    const exchanged = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    })
    expect(exchanged.status).toBe(200)
    const tokens = exchanged.json as unknown as TokenSet
    expect(await ctx.mcpStatus(tokens.access_token)).not.toBe(401)

    const refreshed = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    })
    expect(refreshed.status).toBe(200)
    expect(fetchDocument).toHaveBeenCalledTimes(1)

    const row = await ownerPool.query(
      `SELECT client_name, registration_method, client_secret_hash
       FROM oauth_clients WHERE client_id = $1`,
      [CLIENT_ID],
    )
    expect(row.rows[0]).toMatchObject({
      client_name: 'CIMD Conformance Client',
      registration_method: 'client_id_metadata',
      client_secret_hash: null,
    })
  })

  it('rejects client-secret authentication for a CIMD client', async () => {
    const response = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code: 'not-a-code',
      code_verifier: 'a'.repeat(43),
      client_id: CLIENT_ID,
      client_secret: 'must-not-be-accepted',
    })
    expect(response.status).toBe(401)
    expect(response.json.error).toBe('invalid_client')
  })
})
