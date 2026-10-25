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
  it.each([
    'jev-latest',
    'JEV-LATEST',
    'latest',
    'jev_latest',
    'jev.latest',
  ])('refuses the floating alias %j as the model pin', (model) => {
    expect(() => parseEnv({ JEV_MODEL: model })).toThrow()
  })

  it('treats a whitespace-only model or key as unset and trims the key', () => {
    expect(parseEnv({ JEV_MODEL: '   ' }).JEV_MODEL).toBeUndefined()
    expect(parseEnv({ JEV_API_KEY: '  ' }).JEV_API_KEY).toBeUndefined()
    expect(parseEnv({ JEV_API_KEY: 'k-test\n' }).JEV_API_KEY).toBe('k-test')
  })

  it.each([
    'http://jev.test',
    'https://user:pass@jev.test',
    'https://jev.test/?a=1',
    'https://jev.test/#x',
    'https://jev.test/v1',
    'https://jev.test/v1/',
  ])('refuses the JEV_API_URL %s', (url) => {
    expect(() => parseEnv({ JEV_API_URL: url })).toThrow()
  })

  it('never echoes credentials in a URL rejection', () => {
    expect(() => parseEnv({ JEV_API_URL: 'https://user:hunter2@jev.test' })).not.toThrow(/hunter2/)
  })

  it('treats empty JEV_API_URL as unset', () => {
    expect(parseEnv({ JEV_API_URL: '' }).JEV_API_URL).toBeUndefined()
  })
})
