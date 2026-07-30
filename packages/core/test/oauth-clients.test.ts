// SPDX-License-Identifier: Apache-2.0
// RFC 7591 registration policy — isolated from Postgres
// by mocking the two oauth_clients db helpers (the established core-test seam,
// cf. oauth.test.ts). The in-memory map records EXACTLY what core asked the db
// layer to persist, so the hash-at-rest and the 0005 NULL/NOT-NULL invariants
// are asserted against the same rows the real table would hold.
import { createHash } from 'node:crypto'
import type { NewOAuthClient, OAuthClientRow } from '@3ngram/db'
import type { ClientIdMetadataDocument } from '@3ngram/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const FROZEN_NOW = new Date('2026-06-10T12:00:00Z')

const storedRows = new Map<string, OAuthClientRow>()
const registerClient = vi.fn(async (client: NewOAuthClient): Promise<OAuthClientRow> => {
  const row: OAuthClientRow = {
    ...client,
    registrationMethod: client.registrationMethod ?? 'dynamic_registration',
    createdAt: FROZEN_NOW,
  }
  storedRows.set(client.clientId, row)
  return row
})
const getClientByClientId = vi.fn(
  async (clientId: string): Promise<OAuthClientRow | undefined> => storedRows.get(clientId),
)
const materializeClientMetadata = vi.fn(
  async (document: ClientIdMetadataDocument): Promise<OAuthClientRow | undefined> => {
    const existing = storedRows.get(document.client_id)
    if (existing?.registrationMethod === 'dynamic_registration') return undefined
    const row: OAuthClientRow = {
      clientId: document.client_id,
      clientName: document.client_name,
      redirectUris: document.redirect_uris,
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      registrationMethod: 'client_id_metadata',
      createdAt: existing?.createdAt ?? FROZEN_NOW,
    }
    storedRows.set(document.client_id, row)
    return row
  },
)
vi.mock('@3ngram/db', () => ({
  registerClient,
  getClientByClientId,
  materializeClientMetadata,
}))

const { ClientMetadataResolver } = await import('../src/auth/client-metadata.js')
const {
  authenticateClientCredentials,
  hashClientSecret,
  oauthClientsStore,
  registerOAuthClient,
  resolveOAuthClient,
} = await import('../src/auth/oauth-clients.js')

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

beforeEach(() => {
  storedRows.clear()
  vi.clearAllMocks()
})

describe('registerOAuthClient — public clients', () => {
  it('returns client_id only and keeps client_secret_hash NULL (0005 invariant)', async () => {
    const info = await registerOAuthClient({
      redirect_uris: ['https://app.example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Example',
    })
    expect(typeof info.client_id).toBe('string')
    expect(info).not.toHaveProperty('client_secret')
    expect(info).not.toHaveProperty('client_secret_expires_at')
    const stored = storedRows.get(info.client_id)
    expect(stored?.clientSecretHash).toBeNull()
    expect(stored?.tokenEndpointAuthMethod).toBe('none')
  })
})

describe('registerOAuthClient — confidential clients', () => {
  it.each([
    'client_secret_post',
    'client_secret_basic',
  ] as const)('%s: mints a one-time secret whose SHA-256 hash is at rest (NOT NULL invariant)', async (method) => {
    const info = await registerOAuthClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: method,
      client_name: 'Claude',
    })
    const secret = info.client_secret
    expect(typeof secret).toBe('string')
    // RFC 7591 §3.2.1: REQUIRED when a secret is issued; 0 = never expires.
    expect(info.client_secret_expires_at).toBe(0)
    const stored = storedRows.get(info.client_id)
    // The hash — and ONLY the hash — reached the db layer (hard rule 6).
    expect(stored?.clientSecretHash).toBe(sha256(secret as string))
    expect(stored?.clientSecretHash).not.toBeNull()
    expect(stored?.clientSecretHash).not.toBe(secret)
  })

  it('mints distinct ids and secrets per registration (CSPRNG, never reused)', async () => {
    const input = {
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    } as const
    const first = await registerOAuthClient({ ...input })
    const second = await registerOAuthClient({ ...input })
    expect(first.client_id).not.toBe(second.client_id)
    expect(first.client_secret).not.toBe(second.client_secret)
  })
})

describe('registerOAuthClient — stored metadata', () => {
  it('stores redirect_uris exactly as presented (byte-equality for the A2 matcher)', async () => {
    const uris = ['https://app.example.com/cb?env=prod', 'https://app.example.com/cb']
    const info = await registerOAuthClient({
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
    })
    expect(storedRows.get(info.client_id)?.redirectUris).toEqual(uris)
  })

  it('defaults a missing client_name to the first redirect host (column is NOT NULL)', async () => {
    const info = await registerOAuthClient({
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
    })
    expect(info.client_name).toBe('chatgpt.com')
    expect(storedRows.get(info.client_id)?.clientName).toBe('chatgpt.com')
  })
})

describe('oauthClientsStore.getClient (the A2 contract)', () => {
  it('maps a stored row to RFC 7591 information WITHOUT any secret material', async () => {
    const info = await registerOAuthClient({
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Example',
    })
    const client = await oauthClientsStore.getClient(info.client_id)
    expect(client).toEqual({
      client_id: info.client_id,
      client_id_issued_at: Math.floor(FROZEN_NOW.getTime() / 1000),
      client_name: 'Example',
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
    expect(client).not.toHaveProperty('client_secret')
    expect(client).not.toHaveProperty('clientSecretHash')
  })

  it('returns undefined for an unknown client_id', async () => {
    expect(
      await oauthClientsStore.getClient('00000000-0000-0000-0000-000000000000'),
    ).toBeUndefined()
  })
})

describe('resolveOAuthClient — DCR then CIMD', () => {
  const clientId = 'https://client.example.test/oauth/metadata.json'
  const document = {
    client_id: clientId,
    client_name: 'Metadata Client',
    redirect_uris: ['https://client.example.test/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  } as const

  it('resolves, validates, and materializes CIMD metadata without treating the row as policy', async () => {
    const fetchDocument = vi.fn(async () => ({
      document,
      headers: new Headers({ 'cache-control': 'max-age=60' }),
    }))
    const resolver = new ClientMetadataResolver({ fetchDocument })

    await expect(resolveOAuthClient(clientId, resolver)).resolves.toEqual({
      client_id: clientId,
      client_name: 'Metadata Client',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
    expect(storedRows.get(clientId)?.registrationMethod).toBe('client_id_metadata')
    await resolveOAuthClient(clientId, resolver)
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    expect(materializeClientMetadata).toHaveBeenCalledTimes(2)
  })

  it('keeps a persisted DCR registration ahead of a same-shaped metadata URL', async () => {
    storedRows.set(clientId, {
      clientId,
      clientName: 'Pre-registered',
      redirectUris: ['https://pre.example.test/callback'],
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      registrationMethod: 'dynamic_registration',
      createdAt: FROZEN_NOW,
    })
    const fetchDocument = vi.fn(async () => ({
      document,
      headers: new Headers(),
    }))
    const resolved = await resolveOAuthClient(
      clientId,
      new ClientMetadataResolver({ fetchDocument }),
    )
    expect(resolved?.client_name).toBe('Pre-registered')
    expect(fetchDocument).not.toHaveBeenCalled()
    expect(materializeClientMetadata).not.toHaveBeenCalled()
  })

  it('allows only the public no-secret token path for CIMD clients', async () => {
    const resolver = new ClientMetadataResolver({
      fetchDocument: async () => ({ document, headers: new Headers() }),
    })
    await expect(
      authenticateClientCredentials(clientId, undefined, undefined, resolver),
    ).resolves.toMatchObject({ client_id: clientId, token_endpoint_auth_method: 'none' })
    await expect(
      authenticateClientCredentials(clientId, 'secret', 'client_secret_post', resolver),
    ).resolves.toBeUndefined()
  })
})

describe('hashClientSecret', () => {
  it('is sha256 hex of the plaintext (the A3 token-endpoint compare input)', () => {
    expect(hashClientSecret('s3cret')).toBe(sha256('s3cret'))
  })
})
