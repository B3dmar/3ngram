// SPDX-License-Identifier: Apache-2.0
// MCP PROMPT CONTRACT tests (no DB, no network): the two code-defined prompts
// (briefing, debrief) register on a real McpServer; prompts/list
// returns both with correct argument schemas; prompts/get renders each with
// args. Asserted through an in-memory linked-pair transport (the SDK's real
// prompt handlers), so the contract is the SDK's, not a hand-rolled mirror.
//
// The PROMPTS registry IS the auditable surface: 2 today
// (docs/concepts/mcp-design.mdx), no numeric cap. A prompt orients only — it
// carries no tenant data and reads no DB, so no context/mock is needed.
import { MAX_CONTENT_LENGTH } from '@3ngram/schema'
import { Client as McpClient } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderDebriefPrompt } from '@3ngram/core'
import { PROMPTS, registerPrompts } from '../src/mcp/prompts.js'

/** A connected SDK client wired to a server with only the prompts registered. */
async function connectPromptsClient(): Promise<McpClient> {
  const server = new McpServer({ name: '3ngram-test', version: '0.0.0' })
  registerPrompts(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new McpClient({ name: 'prompt-contract', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

let client: McpClient

beforeEach(async () => {
  client = await connectPromptsClient()
})

describe('MCP prompt registry discipline', () => {
  it('registers exactly 2 prompts (briefing, debrief)', () => {
    // A SNAPSHOT of the registered surface, not a ceiling — the self-imposed
    // prompt cap is gone (docs/concepts/mcp-design.mdx / hard rule 8).
    expect(PROMPTS).toHaveLength(2)
    expect(PROMPTS.map((p) => p.name)).toEqual(['briefing', 'debrief'])
  })
})

describe('prompts/list', () => {
  it('lists both prompts with their titles and argument schemas', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['briefing', 'debrief'])

    const briefing = prompts.find((p) => p.name === 'briefing')
    expect(briefing?.title).toBe('Session briefing')
    const briefingArgs = briefing?.arguments ?? []
    const selector = briefingArgs.find((a) => a.name === 'selector')
    expect(selector?.required).toBe(true)
    const mode = briefingArgs.find((a) => a.name === 'mode')
    expect(mode?.required).toBe(false)

    const debrief = prompts.find((p) => p.name === 'debrief')
    expect(debrief?.title).toBe('Session debrief')
    const scope = (debrief?.arguments ?? []).find((a) => a.name === 'scope')
    expect(scope?.required).toBe(false)
    const project = (debrief?.arguments ?? []).find((a) => a.name === 'project')
    expect(project?.required).toBe(false)
  })
})

describe('prompts/get briefing', () => {
  it('renders a single user message orienting toward the briefing TOOL', async () => {
    const result = await client.getPrompt({
      name: 'briefing',
      arguments: { selector: 'scope', mode: 'full' },
    })
    expect(result.messages).toHaveLength(1)
    const message = result.messages[0]
    expect(message?.role).toBe('user')
    expect(message?.content.type).toBe('text')
    const text = message?.content.type === 'text' ? message.content.text : ''
    // Orients toward the briefing TOOL with the interpolated selector + mode.
    expect(text).toContain('briefing')
    expect(text).toContain('"kind": "scope"')
    expect(text).toContain('"full"')
    // No-firehose: the text demands an explicit selector.
    expect(text.toLowerCase()).toContain('selector')
  })

  it('defaults mode to brief and renders the all selector inline', async () => {
    const result = await client.getPrompt({
      name: 'briefing',
      arguments: { selector: 'all' },
    })
    const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('"kind": "all"')
    expect(text).toContain('"brief"')
  })

  it('rejects an unknown selector value (schema-validated args)', async () => {
    await expect(
      client.getPrompt({ name: 'briefing', arguments: { selector: 'everything' } }),
    ).rejects.toThrow()
  })

  it('rejects a missing required selector', async () => {
    await expect(client.getPrompt({ name: 'briefing', arguments: {} })).rejects.toThrow()
  })
})

describe('prompts/get debrief', () => {
  it('renders an end-of-session template orienting toward remember + resolve', async () => {
    const result = await client.getPrompt({
      name: 'debrief',
      arguments: { scope: 'work' },
    })
    expect(result.messages).toHaveLength(1)
    const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('remember')
    expect(text).toContain('resolve')
    expect(text).toContain('decision')
    expect(text).toContain('commitment')
    // The optional scope arg rides the DELIMITED DATA block, not the imperative
    // sentences — `scopeSchema`/`projectSchema` values reach a tool-capable turn
    // (docs/concepts/session-continuity.mdx layer 4).
    expect(text).toContain('work')
    expect(text).toMatch(/```json\n[\s\S]*"scope": "work"[\s\S]*\n```/)
    expect(text).not.toContain('Tag each memory with scope "work"')
    expect(text).toContain(String(MAX_CONTENT_LENGTH))
    expect(text).toMatch(/ONE typed atom|split/i)
  })

  it('carries NO tenant data — briefedCommitments is the REST render input only', () => {
    // An MCP prompt never queries and never touches the DB (src/mcp/prompts.ts).
    // The hook path is the one with a session row to read briefed rows from.
    const text = renderDebriefPrompt({ scope: 'work' })
    const payload = /```json\n([\s\S]*?)\n```/.exec(text)
    expect(JSON.parse((payload as RegExpExecArray)[1] as string)).toEqual({ scope: 'work' })
  })

  it('renders without the optional scope argument', async () => {
    const result = await client.getPrompt({ name: 'debrief', arguments: {} })
    const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('remember')
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('project')
  })

  it('interpolates project so remember writes can hit a project briefing', async () => {
    const result = await client.getPrompt({
      name: 'debrief',
      arguments: { scope: 'work', project: '3ngram' },
    })
    const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('3ngram')
    expect(text).toContain('work')
  })

  it('rejects a non-canonical scope the remember TOOL would also reject', async () => {
    // The prompt validates `scope` against the canonical scopeSchema (kebab-case),
    // the SAME constraint `remember` enforces — so the rendered "tag with scope X"
    // line can never instruct a value the underlying tool rejects (e.g. "Work Notes").
    await expect(
      client.getPrompt({ name: 'debrief', arguments: { scope: 'Work Notes' } }),
    ).rejects.toThrow()
  })
})
