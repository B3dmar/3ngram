// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  clientIdMetadataDocumentSchema,
  clientIdMetadataUrlSchema,
  oauthClientIdParamSchema,
} from '../src/auth.js'

const clientId = 'https://client.example/oauth/client.json'

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: 'Example MCP Client',
    redirect_uris: ['http://127.0.0.1:4321/callback'],
    ...overrides,
  }
}

describe('clientIdMetadataUrlSchema', () => {
  it('accepts an HTTPS document URL and preserves it byte-exactly', () => {
    expect(clientIdMetadataUrlSchema.parse(clientId)).toBe(clientId)
  })

  it.each([
    'http://client.example/oauth/client.json',
    'https://client.example/',
    'https://user:password@client.example/oauth/client.json',
    'https://client.example/oauth/client.json#fragment',
    'https://client.example/oauth/../client.json',
    'https://client.example/oauth/%2e%2e/client.json',
    'https://client.example/oauth/cliënt.json',
  ])('rejects an invalid client metadata URL: %s', (value) => {
    expect(clientIdMetadataUrlSchema.safeParse(value).success).toBe(false)
  })
})

describe('oauthClientIdParamSchema', () => {
  it('accepts both DCR UUIDs and CIMD URLs for grant revocation', () => {
    expect(oauthClientIdParamSchema.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(
      true,
    )
    expect(oauthClientIdParamSchema.safeParse(clientId).success).toBe(true)
  })
})

describe('clientIdMetadataDocumentSchema', () => {
  it('parses the required MCP fields and defaults a public authorization-code client', () => {
    expect(clientIdMetadataDocumentSchema.parse(document())).toEqual({
      client_id: clientId,
      client_name: 'Example MCP Client',
      redirect_uris: ['http://127.0.0.1:4321/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })
  })

  it.each([
    { client_id: undefined },
    { client_name: undefined },
    { redirect_uris: [] },
    { redirect_uris: ['http://client.example/callback'] },
    { token_endpoint_auth_method: 'client_secret_post' },
    { client_secret: 'must-not-be-accepted' },
    { client_secret_expires_at: 0 },
  ])('rejects unsafe or incomplete metadata: %o', (override) => {
    expect(clientIdMetadataDocumentSchema.safeParse(document(override)).success).toBe(false)
  })

  // grant_types/response_types advertise what the client MAY use. MCP's CIMD
  // requirements for an AS are client_id-matches-URL, redirect_uri validation,
  // and valid JSON with the required fields — grant_types is not among them, so
  // an unsupported entry must NOT condemn the whole document. Rejecting it
  // locked out claude.ai, whose real document is the first case below.
  it('narrows unsupported grant types instead of rejecting the document', () => {
    const parsed = clientIdMetadataDocumentSchema.parse(
      document({
        grant_types: [
          'authorization_code',
          'refresh_token',
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        ],
      }),
    )
    expect(parsed.grant_types).toEqual(['authorization_code', 'refresh_token'])
  })

  it('narrows unsupported response types instead of rejecting the document', () => {
    const parsed = clientIdMetadataDocumentSchema.parse(
      document({ response_types: ['code', 'token', 'id_token'] }),
    )
    expect(parsed.response_types).toEqual(['code'])
  })

  // Narrowing to empty is deliberate: usability is a policy question the
  // /authorize path answers with a precise `unsupported_grant_type`, not a
  // blanket invalid_document from the structural boundary.
  it('narrows to an empty grant list rather than failing structurally', () => {
    const parsed = clientIdMetadataDocumentSchema.parse(
      document({ grant_types: ['client_credentials'] }),
    )
    expect(parsed.grant_types).toEqual([])
  })

  it.each([
    { grant_types: [] },
    { grant_types: 'authorization_code' },
    { response_types: [] },
  ])('still rejects a structurally malformed advertisement: %o', (override) => {
    expect(clientIdMetadataDocumentSchema.safeParse(document(override)).success).toBe(false)
  })
})
