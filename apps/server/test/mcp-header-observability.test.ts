// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { getContext, mcpHeaderRequests, runWithContext } from '@3ngram/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyMcpHeaders,
  mcpHeaderObservability,
} from '../src/middleware/mcp-header-observability.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCP header classification', () => {
  it('keeps recognized tool routing dimensions', () => {
    expect(classifyMcpHeaders('tools/call', 'remember')).toEqual({
      method: 'tools/call',
      name: 'remember',
      status: 'recognized',
    })
  })

  it('replaces arbitrary method and name values with bounded labels', () => {
    expect(classifyMcpHeaders('attacker-controlled', 'private-data')).toEqual({
      method: 'unknown',
      name: 'none',
      status: 'unknown_method',
    })
    expect(classifyMcpHeaders('tools/call', 'attacker-controlled')).toEqual({
      method: 'tools/call',
      name: 'unknown',
      status: 'unknown_name',
    })
  })

  it('classifies missing required hints without reading a body', () => {
    expect(classifyMcpHeaders(undefined, undefined)).toEqual({
      method: 'missing',
      name: 'none',
      status: 'missing_method',
    })
    expect(classifyMcpHeaders('prompts/get', undefined)).toEqual({
      method: 'prompts/get',
      name: 'missing',
      status: 'missing_name',
    })
  })
})

describe('MCP header middleware ordering', () => {
  it('mounts the observer before the global JSON parser', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
    const observerPosition = appSource.indexOf("app.use('/mcp', mcpHeaderObservability)")
    const parserPosition = appSource.indexOf('express.json({')

    expect(observerPosition).toBeGreaterThan(-1)
    expect(parserPosition).toBeGreaterThan(observerPosition)
  })

  it('does not inspect request bodies in the observer', () => {
    const add = vi.spyOn(mcpHeaderRequests, 'add')
    const next = vi.fn()
    const req = {
      header: (name: string) => {
        if (name === 'mcp-method') return 'tools/list'
        return undefined
      },
      get body(): never {
        throw new Error('body must not be read')
      },
    }

    runWithContext({ requestId: 'header-test', surface: 'rest' }, () => {
      expect(() => mcpHeaderObservability(req as never, {} as never, next)).not.toThrow()
      expect(getContext()).toMatchObject({ surface: 'mcp', operation: 'tools/list' })
    })
    expect(add).toHaveBeenCalledWith(1, {
      method: 'tools/list',
      name: 'none',
      status: 'recognized',
    })
    expect(next).toHaveBeenCalledOnce()
  })
})
