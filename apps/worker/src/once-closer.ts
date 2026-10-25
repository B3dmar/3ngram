// SPDX-License-Identifier: Apache-2.0
// In-process closer drain for the one-shot `session-sweep` (no bullmq, no
// ioredis). The sweep's enqueueCloser port collects requests here instead of
// into a queue; they run one at a time AFTER the sweep resolves. Loaded by
// once.ts through a dynamic import, because it pulls in the core/pg graph.
import { loadBudgetConfig, loadLlmGatewayConfig, log } from '@3ngram/config'
import { type BudgetEnforcement, type CloserEnqueueRequest, SELFHOST_LIMITS } from '@3ngram/core'
import { createOpenAIGateway, type Gateway } from '@3ngram/llm'
import { sessionCloserJobId } from '@3ngram/schema'

export interface CloserCollector {
  enqueue: (request: CloserEnqueueRequest) => Promise<void>
  /** Call only after the sweep resolved: enqueues during a drain are not supported. */
  drain: (
    run: (request: CloserEnqueueRequest) => Promise<unknown>,
  ) => Promise<{ attempted: number; failed: number }>
}

/**
 * Keyed by `sessionCloserJobId` (run, epoch), first entry wins: the same
 * dedup the BullMQ jobId gives the resident worker, so the sweep's two
 * producers collapse into one pass while a genuine resurrection does not.
 */
export function createCloserCollector(): CloserCollector {
  const pending = new Map<string, CloserEnqueueRequest>()
  return {
    enqueue: async (request) => {
      const id = sessionCloserJobId(request)
      if (!pending.has(id)) pending.set(id, request)
    },
    drain: async (run) => {
      let attempted = 0
      let failed = 0
      for (const request of pending.values()) {
        attempted++
        try {
          await run(request)
        } catch (err) {
          failed++
          // err.name only (hard rule 6): a provider message may quote the prompt.
          log().warn(
            {
              sessionRunId: request.sessionRunId,
              err: err instanceof Error ? err.name : 'unknown',
            },
            'worker once: closer failed',
          )
        }
      }
      return { attempted, failed }
    },
  }
}

export interface CloserDeps {
  gateway: Gateway | undefined
  budget: BudgetEnforcement
}

/**
 * The closer's gateway and budget. MUST stay in sync with startQueues in
 * src/queues.ts, which builds the same pair for the resident worker.
 */
export function buildCloserDeps(): CloserDeps {
  const gatewayConfig = loadLlmGatewayConfig()
  const gateway = gatewayConfig === undefined ? undefined : createOpenAIGateway(gatewayConfig)
  const budget: BudgetEnforcement = {
    resolveLimits: async () => SELFHOST_LIMITS,
    config: loadBudgetConfig(),
    logger: { warn: (obj, msg) => log().warn(obj, msg) },
  }
  return { gateway, budget }
}
