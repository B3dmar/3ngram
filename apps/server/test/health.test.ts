// SPDX-License-Identifier: Apache-2.0
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err === undefined ? resolve() : reject(err)))
    }),
)

describe('GET /health (S5 hook contract)', () => {
  it('returns 200 with { status: "ok" }', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('carries x-request-id — the context middleware is wired', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  })

  it('does not advertise the framework', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.headers.get('x-powered-by')).toBeNull()
  })

  it('unknown route is a 404, not a crash', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })
})
