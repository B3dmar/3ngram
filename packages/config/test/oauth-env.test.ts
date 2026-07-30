// SPDX-License-Identifier: Apache-2.0
// OAuth env contract: BASE_URL + OAUTH_JWKS fail-fast at
// boot. A malformed key array dies at parse, not at the first token verify; a
// production process missing BASE_URL/OAUTH_JWKS refuses to start; loadOAuthConfig
// derives the issuer (normalized) + RFC 8707 resource from BASE_URL.
import { describe, expect, it } from 'vitest'
import { loadOAuthConfig, parseEnv, resetEnvCache } from '../src/env.js'

// A static RS256 private JWK array fixture (generated once via jose). Kept inline
// so this package's tests stay free of a jose dependency — env validation is pure
// structural (zod), not crypto. The private fields are a throwaway test key.
const validJwks = JSON.stringify([
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

describe('OAuth env validation', () => {
  it('accepts a well-formed BASE_URL + OAUTH_JWKS in any env', () => {
    const env = parseEnv({ BASE_URL: 'https://api.3ngram.test', OAUTH_JWKS: validJwks })
    expect(env.BASE_URL).toBe('https://api.3ngram.test')
    expect(env.OAUTH_JWKS).toBe(validJwks)
  })

  it('boots without OAuth config outside production (skeleton)', () => {
    const env = parseEnv({})
    expect(env.BASE_URL).toBeUndefined()
    expect(env.OAUTH_JWKS).toBeUndefined()
  })

  it('refuses non-JSON OAUTH_JWKS (boot failure, not verify-time)', () => {
    expect(() => parseEnv({ OAUTH_JWKS: 'not json' })).toThrow(/OAUTH_JWKS/)
  })

  it('refuses an empty OAUTH_JWKS array (no signing key)', () => {
    expect(() => parseEnv({ OAUTH_JWKS: '[]' })).toThrow(/OAUTH_JWKS/)
  })

  it('refuses a key missing kid', () => {
    expect(() =>
      parseEnv({ OAUTH_JWKS: '[{"kty":"RSA","alg":"RS256","n":"x","e":"AQAB","d":"y"}]' }),
    ).toThrow(/OAUTH_JWKS/)
  })

  it('refuses a non-RS256 key (kty/alg mismatch)', () => {
    expect(() =>
      parseEnv({ OAUTH_JWKS: '[{"kty":"EC","alg":"ES256","kid":"k","n":"x","e":"y","d":"z"}]' }),
    ).toThrow(/OAUTH_JWKS/)
  })

  it('treats a non-http BASE_URL as unset (Vite injects "/" in tests)', () => {
    // A value without an http(s) scheme is not a deployment issuer; it reads as
    // "not configured" rather than crashing, so dev/test boot is unaffected.
    expect(parseEnv({ BASE_URL: 'not-a-url', OAUTH_JWKS: validJwks }).BASE_URL).toBeUndefined()
    expect(parseEnv({ BASE_URL: '/', OAUTH_JWKS: validJwks }).BASE_URL).toBeUndefined()
  })

  it('requires BASE_URL in production', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', LOG_HASH_SALT: 's', OAUTH_JWKS: validJwks }),
    ).toThrow(/BASE_URL/)
  })

  it('requires an HTTPS BASE_URL in production', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        LOG_HASH_SALT: 's',
        BASE_URL: 'http://api.3ngram.test',
        OAUTH_JWKS: validJwks,
      }),
    ).toThrow(/BASE_URL must use https/)
  })

  it('allows an HTTP loopback BASE_URL outside production', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        BASE_URL: 'http://127.0.0.1:3000',
        OAUTH_JWKS: validJwks,
      }).BASE_URL,
    ).toBe('http://127.0.0.1:3000')
  })

  it('requires OAUTH_JWKS in production', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', LOG_HASH_SALT: 's', BASE_URL: 'https://api.x.test' }),
    ).toThrow(/OAUTH_JWKS/)
  })
})

describe('loadOAuthConfig', () => {
  it('derives a normalized issuer and the RFC 8707 resource from BASE_URL', () => {
    resetEnvCache()
    process.env.BASE_URL = 'https://api.3ngram.test'
    process.env.OAUTH_JWKS = validJwks
    const config = loadOAuthConfig()
    // issuer keeps the normalized trailing slash; resource = issuer + /mcp.
    expect(config.issuer).toBe('https://api.3ngram.test/')
    expect(config.resource).toBe('https://api.3ngram.test/mcp')
    expect(config.keys).toHaveLength(1)
    expect(config.keys[0]?.kid).toBe('k1')
    resetEnvCache()
    delete process.env.BASE_URL
    delete process.env.OAUTH_JWKS
  })

  it('throws when BASE_URL is unset', () => {
    resetEnvCache()
    delete process.env.BASE_URL
    delete process.env.OAUTH_JWKS
    expect(() => loadOAuthConfig()).toThrow(/BASE_URL/)
    resetEnvCache()
  })
})
