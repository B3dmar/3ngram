// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks'

export type Surface = 'mcp' | 'rest' | 'worker'

/**
 * Per-request log context (docs/concepts/observability.mdx §1). Set once at the transport
 * boundary via runWithContext(); never passed by hand.
 */
export interface RequestContext {
  requestId: string
  surface: Surface
  /** Already hashed at the middleware boundary (redaction.ts hashUserId). */
  userIdHash?: string
  operation?: string
  /** MCP only. */
  toolName?: string
  /** MCP only. */
  sessionId?: string
  /** Worker only. */
  jobId?: string
  /** Worker only. */
  queue?: string
  /** Worker only. */
  attempt?: number
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Enter a request scope. Clones `ctx` so later bindContext() patches stay scoped. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run({ ...ctx }, fn)
}

export function getContext(): RequestContext | undefined {
  return storage.getStore()
}

/** For code that must only run inside a request scope. */
export function requireContext(): RequestContext {
  const ctx = storage.getStore()
  if (ctx === undefined) {
    throw new Error('requireContext() called outside runWithContext()')
  }
  return ctx
}

/** Patch the live context, e.g. set `operation` once routing has resolved it. */
export function bindContext(patch: Partial<RequestContext>): void {
  Object.assign(requireContext(), patch)
}
