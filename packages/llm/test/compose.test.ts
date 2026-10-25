// SPDX-License-Identifier: Apache-2.0
// composeGateway (issue #225): embed/complete to the base gateway, decide to the
// judgment gateway; no judgment gateway → the base's typed NotImplementedError.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeGateway } from '../src/compose.js'
import { createFakeGateway } from '../src/fake.js'
import { createOpenAIGateway, NotImplementedError } from '../src/openai.js'
import type { DecideRequest } from '../src/types.js'

const REQUEST: DecideRequest = {
  state: 's',
  questions: { q: { type: 'noul', instructions: 'i' } },
}

afterEach(() => vi.unstubAllGlobals())

describe('composeGateway', () => {
  it('routes embed/complete to base and decide to judgment', async () => {
    const base = createFakeGateway()
    const judgment = createFakeGateway()
    const gw = composeGateway({ base, judgment })
    await gw?.embed(['a'], 'memory.embed')
    await gw?.complete('p', 'session.closer')
    await gw?.decide(REQUEST, 'session.closer.decide')
    expect(base.calls.embed).toHaveLength(1)
    expect(base.calls.complete).toHaveLength(1)
    expect(base.calls.decide).toHaveLength(0)
    expect(judgment.calls.decide).toHaveLength(1)
    expect(judgment.calls.embed).toHaveLength(0)
  })

  it('returns the base unchanged without a judgment gateway (decide is typed-unavailable)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const base = createOpenAIGateway({ baseUrl: 'https://gw.test/v1', apiKey: 'k' })
    const gw = composeGateway({ base })
    expect(gw).toBe(base)
    await expect(gw?.decide(REQUEST, 'op')).rejects.toBeInstanceOf(NotImplementedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is undefined without a base, even when judgment is configured', () => {
    expect(composeGateway({ base: undefined, judgment: createFakeGateway() })).toBeUndefined()
  })
})
