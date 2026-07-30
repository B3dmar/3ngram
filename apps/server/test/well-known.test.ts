// SPDX-License-Identifier: Apache-2.0
// OAuth discovery routes (auth C4a) — contract tests against the in-process app.
// jwks.json shape (PUBLIC keys only, no private fields); RFC 9728
// protected-resource metadata at BOTH the bare path (root resource) and the
// path-suffixed form (the /mcp resource). The config is driven through real env
// (BASE_URL + OAUTH_JWKS) so
// loadOAuthConfig + core's jose-backed public-key derivation run end-to-end.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Static throwaway RS256 private JWK array (generated via jose). The endpoint
// must derive the PUBLIC view and never serve `d`/`p`/`q`/...
const TEST_JWKS = JSON.stringify([
  {
    kty: 'RSA',
    n: '2sUh3fwAEYYFKCqRi3iIgq0X2C6PnaoWqu-HmzwbhGQvKqR62LAxmt3k_pQn-KdnMJCG0yWVWq-9gde-yr2zsp4Zitt0XT_JsCnCRTyR_6C1aiFbl6FzCVR6gbxDeEz5CHDLlbsGbbTY8-k4oQc3Qm3OGOuWUWNhwXGE7-RjesEJUoaYftfxduHbkwAG_A6ENPooUJTbeze_EupWB9nSQYMdvIvmuezwbCTIbkYF1DRRoOEj_d57lY_o_OQ9l9r9TdvoUXJlAw0etZ_karQRt2fASJxFmKk3y_57GCmASh3WRB-9dw0FrdhCpZIBbUvWDSqJxAIv9j4iCOTJ6t2YRQ',
    e: 'AQAB',
    d: 'O0eoniy_XgA5XIFwb-EI6JP7vpYbT2c7_jSqw7s9X5oAF-d67EWOI39WIk_GJwBBm2zGQ-fOuUSertTlu608yL1DgZdmyC_VOJmQLU-05hZHoksItSVH9TLBgW8gvzPoVUuvNtL3cnnLQgij0iqQ5Dy52JHZ6RLrdc4Lbi-ubx_oOT9qBrRZFrXcUuPGVuwPKCFX71SU0R7G54uSILdjnT64WIhJYz7gxtIbuJJcfn9AZLptuHWlffY6iVLVhQf0MTKikTbaPR9nDpR4Ss9NUV8FxN6EOHt7fVcwH5lrCP4FjuyBs21Cl4O4qxJq_fhoaWwAN1cbmgvOZaSjkCVvHw',
    p: '-RaEcpWLPp6eDRq3k9iO2oRH4B3IGTnNMqjKbLjOTRT-PSSystx_ciSadPhVzylOMgugGgl0SGVtqWnJlg9guBGycwJqFCPM2Pkj5DCJZdbzZdMgWOATzffBuziGYH1TfkietL635HSpud9ReIOBUB-hxDZp9JTKJvpc-Gr8L5M',
    q: '4Nc9uy0ggNYLq-tPpaXwoxPysoS3aDodA39YRiQsM_CcLcrdC6buy0GNY4RhsURxiARxw7Onj4_UKoUUXxi01oN4qxah6kbA1evyjLfKVHNfrA9nItSC0VBwmIlQ2FX0To4uoexStSrC-gMe8DIWQeN3WTFuTDdGNGVKXmapD8c',
    dp: 'I7M_fnDCiVIQkw4-O3lxWA5Xgt6h3EO1jko04QpHvzKAEeFdn1cNCR4H6TXijpN7-p5B7xllyi6HXh2kX9aKZTdcHTG-ZG6RIJPsufre5nK9Zd2xqCtNi1q0MJI0aEXuHo5n-L3Q-3RhExvXwG8QrJwsAkROQVjF9HozswMaa_M',
    dq: '2h61WlIrCBGefQfo2pAi5HHDrn-l1c0avHvbzR_mafTv7lSxIE6vtis_2N1iULBPW17EZtBwq4sijqVP3_l95eThOUjZhwdgp6cgRHdAJ7FNjQPcUCPNTPY2ZSRBc73fJh41CwzSJ8L2J8jDSM2uXfknnTWhBPtSdh4ViYMaW50',
    qi: 'JyjN2QLf6OM_FG8sHWVnaVtzzZCfLQ1F2oaYTr3oKnvZP1YGEC1BkQ_jq3U6rzB8vMh7J2hITMUarYoGqf7ZojjoVIR_5nPSjJ7AgIU8p1eVK_qiAN5u5nJpEN1dEzfaJJbKHb3z3Ea3Jyg4obVMX8V9lZTZS77sK58ZZD9_2Is',
    alg: 'RS256',
    kid: 'k1',
  },
])

let server: Server
let baseUrl: string

beforeAll(async () => {
  process.env.BASE_URL = 'https://api.3ngram.test'
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  const { createApp } = await import('../src/app.js')
  server = createApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
})

describe('GET /.well-known/jwks.json', () => {
  it('serves the PUBLIC keys only — never private material', async () => {
    const res = await fetch(`${baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Record<string, unknown>[] }
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys).toHaveLength(1)
    const key = body.keys[0]
    if (key === undefined) throw new Error('expected a key')
    expect(key.kty).toBe('RSA')
    expect(key.alg).toBe('RS256')
    expect(key.use).toBe('sig')
    expect(key.kid).toBe('k1')
    expect(key.n).toBeDefined()
    expect(key.e).toBeDefined()
    for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(key).not.toHaveProperty(priv)
    }
  })
})

describe('RFC 9728 protected-resource discovery', () => {
  it('serves ROOT-resource metadata at the bare path (RFC 9728 root location)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe('https://api.3ngram.test')
    expect(body.authorization_servers).toEqual(['https://api.3ngram.test/'])
  })

  it('serves the /mcp resource metadata at the path-suffixed form', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe('https://api.3ngram.test/mcp')
    expect(body.authorization_servers).toEqual(['https://api.3ngram.test/'])
  })
})

describe('RFC 8414 authorization-server metadata (OAuth AS A2)', () => {
  it('serves metadata whose issuer EXACTLY matches the RS discovery value', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // The same string the protected-resource docs advertise (and tokens carry as iss).
    expect(body.issuer).toBe('https://api.3ngram.test/')
    expect(body.authorization_response_iss_parameter_supported).toBe(true)
    expect(body.authorization_endpoint).toBe('https://api.3ngram.test/oauth/authorize')
    expect(body.token_endpoint).toBe('https://api.3ngram.test/oauth/token')
    expect(body.registration_endpoint).toBe('https://api.3ngram.test/oauth/register')
    expect(body.response_types_supported).toEqual(['code'])
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_post',
      'client_secret_basic',
      'none',
    ])
    expect(body.scopes_supported).toEqual(['memory:read', 'memory:write'])
  })
})
