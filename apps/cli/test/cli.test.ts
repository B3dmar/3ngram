// SPDX-License-Identifier: Apache-2.0
// Unit tests for the 3ngram CLI — NO network. A stub ThreengramClient records each
// call and returns a canned SDK output, and a captured Io collects stdout/stderr
// + the resolved config, so each test asserts: args parse -> the right SDK method
// with the right payload -> both human and --json output, plus the config-missing
// and API-error paths exit non-zero with the right message and NO key leak.

import type {
  FactsToolOutput,
  RememberToolArgs,
  RememberToolOutput,
  SearchRestResponseV2,
  SearchToolOutput,
} from '@3ngram/schema'
import {
  type SearchOptions,
  ThreengramApiError,
  type ThreengramClient,
  type ThreengramClientConfig,
  ThreengramNetworkError,
} from '@3ngram/sdk'
import { describe, expect, it } from 'vitest'
import { API_KEY_ENV, BASE_URL_ENV } from '../src/config.js'
import type { Io } from '../src/io.js'
import { run } from '../src/run.js'

const SECRET_KEY = '3ng_live_super_secret_value'
const ENV = { [BASE_URL_ENV]: 'https://api.example.com', [API_KEY_ENV]: SECRET_KEY }

interface Recorded {
  method: 'remember' | 'search' | 'getFacts'
  payload: unknown
}

/** A stub client capturing the method + payload and returning a canned output. */
function stubClient(outputs: {
  remember?: RememberToolOutput
  search?: SearchRestResponseV2
  facts?: FactsToolOutput
  throws?: unknown
}): { client: ThreengramClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const reject = (): never => {
    throw outputs.throws
  }
  const client = {
    remember: async (input: RememberToolArgs) => {
      calls.push({ method: 'remember', payload: input })
      if (outputs.throws !== undefined) return reject()
      return outputs.remember as RememberToolOutput
    },
    search: async (query: string, opts?: SearchOptions) => {
      calls.push({ method: 'search', payload: { query, opts } })
      if (outputs.throws !== undefined) return reject()
      return outputs.search as SearchRestResponseV2
    },
    getFacts: async (filters?: unknown) => {
      calls.push({ method: 'getFacts', payload: filters })
      if (outputs.throws !== undefined) return reject()
      return outputs.facts as FactsToolOutput
    },
  } as unknown as ThreengramClient
  return { client, calls }
}

/** A captured Io: collects stdout/stderr lines and the config the client was built from. */
function captureIo(
  client: ThreengramClient,
  env: Record<string, string | undefined> = ENV,
): { io: Io; out: string[]; err: string[]; configs: ThreengramClientConfig[] } {
  const out: string[] = []
  const err: string[] = []
  const configs: ThreengramClientConfig[] = []
  const io: Io = {
    version: '0.8.0-test',
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    makeClient: (config) => {
      configs.push(config)
      return client
    },
  }
  return { io, out, err, configs }
}

describe('global metadata', () => {
  it('prints the injected package version without resolving config or creating a client', async () => {
    const { client, calls } = stubClient({ facts: { facts: [], count: 0 } })
    const { io, out, err, configs } = captureIo(client, {})

    const code = await run(['--version'], io)

    expect(code).toBe(0)
    expect(out).toEqual(['0.8.0-test'])
    expect(err).toHaveLength(0)
    expect(configs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

const REMEMBER_OUT: RememberToolOutput = {
  memory: {
    id: '11111111-1111-1111-1111-111111111111',
    memoryType: 'note',
    topic: 'tsconfig',
    scope: 'work',
    project: '3ngram',
  },
  embedded: 'pending',
}

describe('remember command', () => {
  it('parses flags, calls client.remember with the payload, prints human output', async () => {
    const { client, calls } = stubClient({ remember: REMEMBER_OUT })
    const { io, out } = captureIo(client)

    const code = await run(
      ['remember', '--type', 'note', '--topic', 'tsconfig', '--content', 'use NodeNext'],
      io,
    )

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        method: 'remember',
        payload: { memoryType: 'note', topic: 'tsconfig', content: 'use NodeNext' },
      },
    ])
    expect(out.join('\n')).toContain('remembered note 11111111-1111-1111-1111-111111111111')
    expect(out.join('\n')).toContain('embed:   pending')
  })

  it('collects optional scope/project and repeatable + comma tags', async () => {
    const { client, calls } = stubClient({ remember: REMEMBER_OUT })
    const { io } = captureIo(client)

    await run(
      [
        'remember',
        '--type',
        'note',
        '--topic',
        't',
        '--content',
        'c',
        '--scope',
        'work',
        '--project',
        '3ngram',
        '--tags',
        'a,b',
        '--tags',
        'c',
      ],
      io,
    )

    expect(calls[0]?.payload).toEqual({
      memoryType: 'note',
      topic: 't',
      content: 'c',
      scope: 'work',
      project: '3ngram',
      tags: ['a', 'b', 'c'],
    })
  })

  it('--json prints the raw SDK response', async () => {
    const { client } = stubClient({ remember: REMEMBER_OUT })
    const { io, out } = captureIo(client)

    await run(['remember', '--type', 'note', '--topic', 't', '--content', 'c', '--json'], io)

    expect(JSON.parse(out.join('\n'))).toEqual(REMEMBER_OUT)
  })

  it('exits non-zero with a usage message when a required flag is missing', async () => {
    const { client, calls } = stubClient({ remember: REMEMBER_OUT })
    const { io, err } = captureIo(client)

    const code = await run(['remember', '--type', 'note', '--topic', 't'], io)

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(err.join('\n')).toContain('--content is required')
    expect(err.join('\n')).toContain('usage: 3ngram')
  })
})

const SEARCH_OUT: SearchToolOutput = {
  hits: [
    {
      id: '22222222-2222-2222-2222-222222222222',
      memoryType: 'decision',
      topic: 'layering',
      content: 'apps -> core -> db',
      score: 0.873,
    },
  ],
  count: 1,
}

describe('search command', () => {
  it('takes a positional query and maps filters into SearchOptions', async () => {
    const { client, calls } = stubClient({ search: SEARCH_OUT })
    const { io, out } = captureIo(client)

    const code = await run(
      ['search', 'vector db', '--limit', '10', '--type', 'decision', '--scope', 'work'],
      io,
    )

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        method: 'search',
        payload: { query: 'vector db', opts: { limit: 10, memoryType: 'decision', scope: 'work' } },
      },
    ])
    expect(out.join('\n')).toContain('1 match')
    expect(out.join('\n')).toContain('[0.873] decision')
  })

  it('accepts --query as an alternative to the positional', async () => {
    const { client, calls } = stubClient({ search: SEARCH_OUT })
    const { io } = captureIo(client)

    await run(['search', '--query', 'embeddings'], io)

    expect(calls[0]?.payload).toEqual({ query: 'embeddings', opts: {} })
  })

  it('--json prints the raw response and exits 0', async () => {
    const { client } = stubClient({ search: SEARCH_OUT })
    const { io, out } = captureIo(client)

    const code = await run(['search', 'x', '--json'], io)

    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n'))).toEqual(SEARCH_OUT)
  })

  it('surfaces the retrieval-policy scope in human output, including empty results', async () => {
    const scoped = { ...SEARCH_OUT, appliedScope: 'work' }
    const { client } = stubClient({ search: scoped })
    const { io, out } = captureIo(client)

    await run(['search', 'x'], io)
    expect(out.join('\n')).toContain('retrieval scope: work (policy applied)')

    const empty = stubClient({ search: { hits: [], count: 0, appliedScope: 'personal' } })
    const captured = captureIo(empty.client)
    await run(['search', 'x'], captured.io)
    expect(captured.out.join('\n')).toContain('retrieval scope: personal (policy applied)')
    expect(captured.out.join('\n')).toContain('no matches')
  })

  it('exits non-zero when no query is supplied', async () => {
    const { client, calls } = stubClient({ search: SEARCH_OUT })
    const { io, err } = captureIo(client)

    const code = await run(['search'], io)

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(err.join('\n')).toContain('search requires a query')
  })
})

const FACTS_OUT: FactsToolOutput = {
  facts: [
    {
      id: '33333333-3333-3333-3333-333333333333',
      subject: 'seb',
      predicate: 'prefers',
      value: 'rg over grep',
      confidence: 0.9,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
    },
  ],
  count: 1,
}

describe('facts command', () => {
  it('maps --valid-at/--as-known-at into the asOf shape', async () => {
    const { client, calls } = stubClient({ facts: FACTS_OUT })
    const { io, out } = captureIo(client)

    const code = await run(
      [
        'facts',
        '--subject',
        'seb',
        '--limit',
        '20',
        '--valid-at',
        '2026-01-01T00:00:00.000Z',
        '--as-known-at',
        '2026-02-01T00:00:00.000Z',
      ],
      io,
    )

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        method: 'getFacts',
        payload: {
          subject: 'seb',
          limit: 20,
          asOf: { validAt: '2026-01-01T00:00:00.000Z', asKnownAt: '2026-02-01T00:00:00.000Z' },
        },
      },
    ])
    expect(out.join('\n')).toContain('1 fact')
    expect(out.join('\n')).toContain('seb prefers rg over grep')
  })

  it('with no filters calls getFacts with an empty filter object', async () => {
    const { client, calls } = stubClient({ facts: { facts: [], count: 0 } })
    const { io, out } = captureIo(client)

    await run(['facts'], io)

    expect(calls[0]?.payload).toEqual({})
    expect(out.join('\n')).toContain('no facts')
  })

  it('--json prints the raw response', async () => {
    const { client } = stubClient({ facts: FACTS_OUT })
    const { io, out } = captureIo(client)

    await run(['facts', '--json'], io)

    expect(JSON.parse(out.join('\n'))).toEqual(FACTS_OUT)
  })
})

describe('config resolution', () => {
  it('exits non-zero with a clear message when base URL is missing — no key leak', async () => {
    const { client } = stubClient({ remember: REMEMBER_OUT })
    const { io, err } = captureIo(client, { [API_KEY_ENV]: SECRET_KEY })

    const code = await run(['remember', '--type', 'note', '--topic', 't', '--content', 'c'], io)

    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('missing base URL')
    expect(err.join('\n')).not.toContain(SECRET_KEY)
  })

  it('exits non-zero when the API key is missing and never echoes it', async () => {
    const { client } = stubClient({ remember: REMEMBER_OUT })
    const { io, err } = captureIo(client, { [BASE_URL_ENV]: 'https://api.example.com' })

    const code = await run(['facts'], io)

    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('missing API key')
    expect(err.join('\n')).not.toContain('3ng_')
  })

  it('flags override env for both base URL and api key', async () => {
    const { client } = stubClient({ facts: { facts: [], count: 0 } })
    const { io, configs } = captureIo(client)

    await run(['facts', '--base-url', 'https://flag.example.com', '--api-key', 'k_flag'], io)

    expect(configs[0]).toEqual({ baseUrl: 'https://flag.example.com', apiKey: 'k_flag' })
  })
})

describe('error mapping', () => {
  it('maps ThreengramApiError to a friendly line with status + reason, exit non-zero', async () => {
    const { client } = stubClient({ throws: new ThreengramApiError(404, 'not_found') })
    const { io, err, out } = captureIo(client)

    const code = await run(['facts'], io)

    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('404 not_found')
    expect(out).toHaveLength(0)
  })

  it('prints retrieval-policy recovery detail from the SDK error', async () => {
    const detail = 'registered scopes: personal, work'
    const { client } = stubClient({
      throws: new ThreengramApiError(400, 'invalid_input', detail),
    })
    const { io, err } = captureIo(client)

    const code = await run(['search', 'x'], io)

    expect(code).toBe(1)
    expect(err).toContain(`detail: ${detail}`)
  })

  it('maps ThreengramNetworkError to a "could not reach" line, exit non-zero', async () => {
    const { client } = stubClient({ throws: new ThreengramNetworkError('x', new Error('refused')) })
    const { io, err } = captureIo(client)

    const code = await run(['search', 'x'], io)

    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('could not reach the 3ngram server')
  })

  it('an unknown command prints usage and exits non-zero, never leaking the key', async () => {
    const { client, calls } = stubClient({ facts: FACTS_OUT })
    const { io, err } = captureIo(client)

    const code = await run(['frobnicate'], io)

    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(err.join('\n')).toContain("unknown command 'frobnicate'")
    expect(err.join('\n')).not.toContain(SECRET_KEY)
  })

  it('no command prints usage and exits non-zero', async () => {
    const { client } = stubClient({ facts: FACTS_OUT })
    const { io, err } = captureIo(client)

    const code = await run([], io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('usage: 3ngram')
  })
})
