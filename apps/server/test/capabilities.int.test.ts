// SPDX-License-Identifier: Apache-2.0
// Capability-discovery surface — contract tests against
// the in-process Apache app. The capability document returns base-only with the
// default (no-op) extension, and base ∪ extension-caps when an Extension is
// injected. The injected extension here is a TEST-LOCAL MOCK, never the real
// hosted implementation — that code lives in the private platform repository
// and is never imported from this Apache codebase. The real hosted assertion
// lives in the private repository's seam integration test.
import type { Server } from 'node:http'
import type { CapabilityDescriptor } from '@3ngram/schema'
import type { Express } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type Extension } from '../src/app.js'

const CAPABILITIES_PATH = '/.well-known/3ngram-capabilities'

interface CapabilityDocument {
  capabilities: CapabilityDescriptor[]
}

const mockCapability: CapabilityDescriptor = {
  name: 'mock.hosted-surface',
  available: true,
  kind: 'rest',
}
const mockExtension: Extension = {
  capabilities: [mockCapability],
  register() {},
}

let server: Server | undefined

async function listen(app: Express): Promise<string> {
  const started = app.listen(0)
  server = started
  await new Promise<void>((resolve) => started.once('listening', resolve))
  const address = started.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function fetchCapabilities(baseUrl: string): Promise<CapabilityDocument> {
  const res = await fetch(`${baseUrl}${CAPABILITIES_PATH}`)
  expect(res.status).toBe(200)
  return (await res.json()) as CapabilityDocument
}

afterEach(async () => {
  if (server === undefined) return
  const closing = server
  server = undefined
  await new Promise<void>((resolve, reject) => {
    closing.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

describe('GET /.well-known/3ngram-capabilities', () => {
  it('returns base Apache capabilities only with the default (no-op) extension', async () => {
    const baseUrl = await listen(createApp())
    const { capabilities } = await fetchCapabilities(baseUrl)
    const names = capabilities.map((c) => c.name)
    expect(names).toContain('memory.core')
    expect(names).not.toContain('mock.hosted-surface')
  })

  it('returns base ∪ extension capabilities when an Extension is injected', async () => {
    const baseUrl = await listen(createApp({ extension: mockExtension }))
    const { capabilities } = await fetchCapabilities(baseUrl)
    const names = capabilities.map((c) => c.name)
    expect(names).toContain('memory.core')
    expect(names).toContain('mock.hosted-surface')
  })
})
