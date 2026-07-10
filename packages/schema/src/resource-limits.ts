// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod'

/** Public resource dimensions that an injected platform policy may cap. */
export const resourceLimitKindSchema = z.enum(['live_memories', 'active_mcp_clients'])

export type ResourceLimitKind = z.infer<typeof resourceLimitKindSchema>

/**
 * Billing-neutral resource limits. Omitted values are unlimited, which keeps
 * the Apache self-host default unrestricted without encoding commercial tiers.
 */
export const resourceLimitsSchema = z
  .object({
    maxLiveMemories: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    maxActiveMcpClients: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>
