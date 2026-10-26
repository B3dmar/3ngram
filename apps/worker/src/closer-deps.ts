// SPDX-License-Identifier: Apache-2.0
// The session closer's gateway and budget, built once per process. The ONE
// source for both worker modes: the resident BullMQ worker (src/queues.ts) and
// the one-shot session-sweep (src/once.ts). Two copies drifted once: the
// one-shot build lost the Jev judgment gateway, so opted-in tenants silently
// fell back to complete() on a cron schedule.
import { loadBudgetConfig, loadJevGatewayConfig, loadLlmGatewayConfig, log } from '@3ngram/config'
import { type BudgetEnforcement, SELFHOST_LIMITS } from '@3ngram/core'
import { composeGateway, createJevGateway, createOpenAIGateway, type Gateway } from '@3ngram/llm'

export interface CloserDeps {
  gateway: Gateway | undefined
  budget: BudgetEnforcement
}

/**
 * Resolve the gateway ONCE at boot, env-gated exactly as apps/server does.
 * Absent LLM config yields undefined, and every closer pass then reports
 * `no-gateway` and writes nothing: the correct degraded behaviour for a
 * self-host deployment with no LLM. decide() routes to Jev only when JEV_API_KEY
 * and JEV_MODEL are set (issue #225); otherwise it rejects with a typed
 * NotImplementedError and the closer keeps the complete() path.
 *
 * The budget is the closer's own: self-host resolves empty limits and falls
 * through to the config default cap, so a background pass over the cap is
 * REJECTED rather than silently billed.
 */
export function buildCloserDeps(): CloserDeps {
  const gatewayConfig = loadLlmGatewayConfig()
  const jevConfig = loadJevGatewayConfig()
  if (jevConfig !== undefined && gatewayConfig === undefined) {
    log().warn({}, 'JEV_* set without LLM_GATEWAY_URL/LLM_GATEWAY_API_KEY: decide() unavailable')
  }
  const gateway = composeGateway({
    base: gatewayConfig === undefined ? undefined : createOpenAIGateway(gatewayConfig),
    judgment: jevConfig === undefined ? undefined : createJevGateway(jevConfig),
  })
  const budget: BudgetEnforcement = {
    resolveLimits: async () => SELFHOST_LIMITS,
    config: loadBudgetConfig(),
    logger: { warn: (obj, msg) => log().warn(obj, msg) },
  }
  return { gateway, budget }
}
