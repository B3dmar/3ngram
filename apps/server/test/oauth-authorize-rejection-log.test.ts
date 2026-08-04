// SPDX-License-Identifier: Apache-2.0
// GET /oauth/authorize rejection line. Before this line existed, EVERY failure
// on this route — a stale registration, a CIMD document that never loaded, a
// redirect_uri that did not match — surfaced as an identical bare
// 400 { error: 'invalid_client' } with nothing written anywhere, so an operator
// tailing production logs could not tell the classes apart.
//
// Test strategy mirrors oauth-authorize.test.ts (mock the resolveOAuthClient
// seam so no DB or metadata network is needed) and oauth-token-outcome-log.test.ts
// (capture the real serialized log via setLogDestination). Only GET is exercised:
// the POST path additionally calls loadOAuthConfig(), which is irrelevant here.
import type { Server } from 'node:http'
import { contentDigest, setLogDestination } from '@3ngram/config'
import type { ClientResolutionFailure } from '@3ngram/core/auth'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

interface ResolveOptions {
  onFailure?: (reason: ClientResolutionFailure) => void
}

// Drives the seam per test: either report a resolution failure (returning
// undefined, exactly as the real core does) or hand back a client.
let resolveBehavior: (options: ResolveOptions) => object | undefined = () => undefined

const mockResolveOAuthClient = vi.fn(
  async (_clientId: string, _resolver: unknown, options: ResolveOptions = {}) =>
    resolveBehavior(options),
)

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return { ...actual, resolveOAuthClient: mockResolveOAuthClient }
})

const { createTestApp } = await import('./test-app.js')

// A CIMD-shaped client_id: the case that motivated the line, and the one where
// hard rule 6 bites (a URL may carry a query component, so nothing raw is safe).
const CLIENT_ID = 'https://client.example.test/oauth/client-metadata.json'
const REGISTERED_REDIRECT = 'https://client.example.test/callback'

let server: Server
let baseUrl: string

interface LogLine {
  msg?: string
  [key: string]: unknown
}
const logLines: LogLine[] = []

function lastRejectionLine(): LogLine | undefined {
  return logLines.filter((line) => line.msg === 'oauth: authorize endpoint').at(-1)
}

async function authorizeGet(redirectUri = REGISTERED_REDIRECT): Promise<number> {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'test-state-value',
  })
  const res = await fetch(`${baseUrl}/oauth/authorize?${query.toString()}`)
  await res.text()
  return res.status
}

beforeAll(async () => {
  setLogDestination({
    write(chunk: string) {
      logLines.push(JSON.parse(chunk) as LogLine)
    },
  })
  server = createTestApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(() => {
  logLines.length = 0
  resolveBehavior = () => undefined
})

afterAll(async () => {
  setLogDestination()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

describe('GET /oauth/authorize — rejection outcome line', () => {
  it('records the CIMD failure reason that the 400 body deliberately hides', async () => {
    resolveBehavior = (options) => {
      options.onFailure?.('metadata_unsafe_address')
      return undefined
    }

    expect(await authorizeGet()).toBe(400)

    const line = lastRejectionLine()
    expect(line?.outcome).toBe('invalid_client')
    expect(line?.reason).toBe('metadata_unsafe_address')
    expect(line?.client_id_prefix).toBe(`sha8:${contentDigest(CLIENT_ID)}`)
  })

  it('distinguishes a stale registration from a metadata failure', async () => {
    resolveBehavior = (options) => {
      options.onFailure?.('not_registered')
      return undefined
    }

    expect(await authorizeGet()).toBe(400)
    expect(lastRejectionLine()?.reason).toBe('not_registered')
  })

  it('reports a redirect_uri that does not match the resolved client', async () => {
    resolveBehavior = () => ({
      client_id: CLIENT_ID,
      client_name: 'Rejection Log Test Client',
      redirect_uris: [REGISTERED_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })

    expect(await authorizeGet('https://attacker.example.test/callback')).toBe(400)
    expect(lastRejectionLine()?.reason).toBe('redirect_uri_mismatch')
  })

  it('never writes the raw client_id into the line (hard rule 6)', async () => {
    resolveBehavior = (options) => {
      options.onFailure?.('metadata_invalid_document')
      return undefined
    }

    expect(await authorizeGet()).toBe(400)
    expect(JSON.stringify(lastRejectionLine())).not.toContain(CLIENT_ID)
  })

  it('stays silent when the client resolves and the consent form renders', async () => {
    resolveBehavior = () => ({
      client_id: CLIENT_ID,
      client_name: 'Rejection Log Test Client',
      redirect_uris: [REGISTERED_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })

    expect(await authorizeGet()).toBe(200)
    expect(lastRejectionLine()).toBeUndefined()
  })
})
