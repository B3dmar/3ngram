// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  clientIdMetadataDocumentSchema,
  clientIdMetadataUrlSchema,
  clientRegistrationInputSchema,
  oauthClientIdParamSchema,
  redirectUriSchema,
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

  // Asymmetric with grant_types ON PURPOSE: /authorize rejects a client lacking
  // authorization_code, but nothing downstream consults response_types, so a
  // document advertising only `token` would otherwise be issued an
  // authorization code it never advertised support for.
  it('rejects a document whose response types narrow to empty', () => {
    expect(
      clientIdMetadataDocumentSchema.safeParse(document({ response_types: ['token'] })).success,
    ).toBe(false)
  })

  // A per-element length cap would reject before the filter runs, so one long
  // vendor extension URI would condemn a document we can otherwise serve —
  // exactly what narrowing exists to prevent. Size is bounded upstream (the
  // resolver caps the fetched document at 5 KiB) and by the array length here.
  it('narrows a long unsupported extension grant instead of rejecting it', () => {
    const longGrant = `urn:example:params:oauth:grant-type:${'x'.repeat(200)}`
    const parsed = clientIdMetadataDocumentSchema.parse(
      document({ grant_types: ['authorization_code', longGrant] }),
    )
    expect(parsed.grant_types).toEqual(['authorization_code'])
  })

  it('narrows a long unsupported response type instead of rejecting it', () => {
    const parsed = clientIdMetadataDocumentSchema.parse(
      document({ response_types: ['code', 'y'.repeat(300)] }),
    )
    expect(parsed.response_types).toEqual(['code'])
  })
})

// RFC 8252 §7.3 names THREE loopback literals — `localhost`, `127.0.0.1` and
// the IPv6 `[::1]` — and an IPv6-only native client can bind no other. The
// http allowlist covered the first two, so core's loopback port matching could
// never see a registered `[::1]`: the registration (DCR) or the metadata
// document (CIMD) was rejected at this boundary first.
describe('redirectUriSchema (RFC 8252 loopback hosts)', () => {
  it.each([
    'http://localhost/callback',
    'http://localhost:4000/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:4000/callback',
    'http://[::1]/callback',
    'http://[::1]:4000/callback',
    'https://client.example/callback',
    'https://client.example:8443/callback',
  ])('accepts %s and preserves it byte-exactly', (uri) => {
    expect(redirectUriSchema.parse(uri)).toBe(uri)
  })

  // The pattern sees WHATWG `URL.hostname`, which is BRACKETED and already
  // canonicalized — so every spelling of the IPv6 loopback arrives as `[::1]`,
  // and the value is still STORED exactly as it was presented.
  it('accepts a non-canonical spelling of the IPv6 loopback, unmodified', () => {
    expect(redirectUriSchema.parse('http://[0:0:0:0:0:0:0:1]/callback')).toBe(
      'http://[0:0:0:0:0:0:0:1]/callback',
    )
  })

  it.each([
    // Another IPv6 address is not the loopback, however close it reads.
    'http://[::2]/callback',
    'http://[fe80::1]/callback',
    'http://[::ffff:127.0.0.1]/callback',
    // http stays loopback-only; everything else must be https.
    'http://client.example/callback',
    'http://127.0.0.2/callback',
    // A fragment is banned outright (RFC 6749 §3.1.2), loopback included.
    'http://[::1]/callback#fragment',
  ])('rejects %s', (uri) => {
    expect(redirectUriSchema.safeParse(uri).success).toBe(false)
  })

  it('accepts an IPv6-loopback redirect through the DCR and CIMD boundaries', () => {
    const uri = 'http://[::1]/callback'
    expect(clientRegistrationInputSchema.parse({ redirect_uris: [uri] }).redirect_uris).toEqual([
      uri,
    ])
    expect(
      clientIdMetadataDocumentSchema.parse(document({ redirect_uris: [uri] })).redirect_uris,
    ).toEqual([uri])
  })
})
