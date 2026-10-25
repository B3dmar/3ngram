// SPDX-License-Identifier: Apache-2.0
// Judgment-gateway env (issue #225): env-gated, empty-is-unset, an explicit
// model pin, https only — and a half-configured pair fails loud without ever
// echoing the key.
import { afterEach, describe, expect, it } from 'vitest'
import { loadJevGatewayConfig, parseEnv, resetEnvCache } from '../src/env.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  resetEnvCache()
})

function withEnv(env: Record<string, string>): void {
  process.env = env
  resetEnvCache()
}

describe('loadJevGatewayConfig', () => {
  it('is undefined when nothing is set, and when the pair is empty strings', () => {
    withEnv({})
    expect(loadJevGatewayConfig()).toBeUndefined()
    withEnv({ JEV_API_KEY: '', JEV_MODEL: '' })
    expect(loadJevGatewayConfig()).toBeUndefined()
  })

  it('resolves key + pinned model, leaving the API root to @3ngram/llm', () => {
    withEnv({ JEV_API_KEY: 'k-test', JEV_MODEL: 'jev-1.13.0' })
    expect(loadJevGatewayConfig()).toEqual({
      apiKey: 'k-test',
      model: 'jev-1.13.0',
    })
  })

  it('honours an explicit https JEV_API_URL', () => {
    withEnv({ JEV_API_URL: 'https://jev.test', JEV_API_KEY: 'k', JEV_MODEL: 'jev-1.13.0' })
    expect(loadJevGatewayConfig()?.baseUrl).toBe('https://jev.test')
  })

  it('throws, naming the variables but never the key, when the model is missing', () => {
    withEnv({ JEV_API_KEY: 'k-secret-value' })
    expect(() => loadJevGatewayConfig()).toThrow(/JEV_MODEL/)
    expect(() => loadJevGatewayConfig()).not.toThrow(/k-secret-value/)
  })

  it('throws when a model is set without a key', () => {
    withEnv({ JEV_MODEL: 'jev-1.13.0' })
    expect(() => loadJevGatewayConfig()).toThrow(/JEV_API_KEY/)
  })
})

describe('JEV_* env schema', () => {
  it('refuses a -latest alias as the model pin', () => {
    expect(() => parseEnv({ JEV_MODEL: 'jev-latest' })).toThrow()
    expect(() => parseEnv({ JEV_MODEL: 'JEV-LATEST' })).toThrow()
  })

  it('refuses a non-https JEV_API_URL', () => {
    expect(() => parseEnv({ JEV_API_URL: 'http://jev.test' })).toThrow()
  })

  it('treats empty JEV_API_URL as unset', () => {
    expect(parseEnv({ JEV_API_URL: '' }).JEV_API_URL).toBeUndefined()
  })
})
