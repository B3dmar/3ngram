// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  bindContext,
  getContext,
  type RequestContext,
  requireContext,
  runWithContext,
} from '../src/context.js'
import { contextBindings } from '../src/logger.js'

const baseCtx: RequestContext = {
  requestId: 'req-1',
  surface: 'mcp',
  userIdHash: 'u_abc123',
  toolName: 'remember',
}

describe('request context (AsyncLocalStorage)', () => {
  it('propagates through sync and async call chains', async () => {
    await runWithContext(baseCtx, async () => {
      expect(getContext()?.requestId).toBe('req-1')
      await Promise.resolve()
      expect(getContext()?.toolName).toBe('remember')
    })
  })

  it('is undefined outside a scope; requireContext throws', () => {
    expect(getContext()).toBeUndefined()
    expect(() => requireContext()).toThrow(/outside runWithContext/)
  })

  it('nested scopes shadow and restore', () => {
    runWithContext(baseCtx, () => {
      runWithContext({ requestId: 'req-2', surface: 'worker', jobId: 'job-9' }, () => {
        expect(getContext()?.requestId).toBe('req-2')
        expect(getContext()?.jobId).toBe('job-9')
      })
      expect(getContext()?.requestId).toBe('req-1')
    })
  })

  it('bindContext patches the live scope without leaking to the caller object', () => {
    runWithContext(baseCtx, () => {
      bindContext({ operation: 'memory.write' })
      expect(getContext()?.operation).toBe('memory.write')
    })
    expect(baseCtx.operation).toBeUndefined()
  })

  it('maps camelCase context to snake_case log keys, skipping unset fields', () => {
    const bindings = contextBindings(baseCtx)
    expect(bindings).toEqual({
      request_id: 'req-1',
      surface: 'mcp',
      user_id: 'u_abc123',
      tool_name: 'remember',
    })
  })

  it('isolates parallel async tasks', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithContext({ requestId: id, surface: 'rest' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return getContext()?.requestId
        }),
      ),
    )
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
