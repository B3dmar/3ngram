// SPDX-License-Identifier: Apache-2.0
export {
  bindContext,
  getContext,
  type RequestContext,
  requireContext,
  runWithContext,
  type Surface,
} from './context.js'
export {
  type BudgetConfig,
  type Env,
  envSchema,
  isAllowedMcpOrigin,
  type LlmGatewayConfig,
  LOG_LEVELS,
  loadBudgetConfig,
  loadEnv,
  loadLlmGatewayConfig,
  loadMcpAllowedOrigins,
  loadOAuthConfig,
  loadSessionCloserConfig,
  loadSmtpConfig,
  OAUTH_RESOURCE_PATH,
  type OAuthConfig,
  type OAuthJwk,
  parseEnv,
  resetEnvCache,
  type SessionCloserConfig,
  type SmtpConfig,
} from './env.js'
export { contextBindings, createLogger, log, logger, setLogDestination } from './logger.js'
// otel.ts is intentionally NOT re-exported: importing it has SDK side effects.
// Apps import '@3ngram/config/otel' first in their entrypoint.
export {
  budgetGateLookupFailure,
  consolidationAccepted,
  consolidationProposed,
  consolidationRejected,
  generationCostObserved,
  mcpHeaderRequests,
  mcpToolCalls,
  mcpToolErrors,
  memorySuperseded,
  memoryWritten,
  rateLimitStoreFailure,
  searchLatencyMs,
} from './metrics.js'
export {
  contentDigest,
  debugContentEnabled,
  hashUserId,
  REDACTED,
  REDACTED_FIELDS,
  redactDeep,
} from './redaction.js'
