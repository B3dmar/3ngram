// SPDX-License-Identifier: Apache-2.0

import { type ResourceLimits, resourceLimitsSchema } from '@3ngram/schema'
import type { LimitsResolver } from './budget.js'

/** Resolve and validate only the public resource-limit fields, failing closed. */
export async function resolveResourceLimits(
  resolver: LimitsResolver | undefined,
  userId: string,
): Promise<ResourceLimits> {
  if (resolver === undefined) return {}
  const limits = await resolver(userId)
  return resourceLimitsSchema.parse({
    maxLiveMemories: limits.maxLiveMemories,
    maxActiveMcpClients: limits.maxActiveMcpClients,
  })
}
