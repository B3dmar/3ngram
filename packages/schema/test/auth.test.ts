// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { clientIdMetadataDocumentSchema, clientIdMetadataUrlSchema } from '../src/auth.js'

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
  ])('rejects an invalid client metadata URL: %s', (value) => {
    expect(clientIdMetadataUrlSchema.safeParse(value).success).toBe(false)
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
})
