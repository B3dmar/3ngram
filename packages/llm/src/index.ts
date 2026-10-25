// SPDX-License-Identifier: Apache-2.0

export type { ComposeGatewayParts } from './compose.js'
export { composeGateway } from './compose.js'
export type { FakeGatewayOptions } from './fake.js'
export {
  createFakeGateway,
  FAKE_COMPLETION_MODEL,
  FAKE_DECIDE_MODEL,
  FAKE_DEFAULT_PROBABILITY,
  FAKE_EMBEDDING_MODEL,
  fakeEmbedding,
} from './fake.js'
export type { JevGatewayConfig } from './jev.js'
export {
  createJevGateway,
  InvalidDecideError,
  JEV_DEFAULT_BASE_URL,
  MAX_DECIDE_QUESTIONS,
  MAX_DECIDE_STATE_CHARS,
} from './jev.js'
export type { OpenAIGatewayConfig } from './openai.js'
export {
  COMPLETION_MODEL,
  createOpenAIGateway,
  EMBEDDING_MODEL,
  GatewayRequestError,
  InvalidCompletionResponseError,
  InvalidEmbeddingResponseError,
  NotImplementedError,
} from './openai.js'
export type {
  CapabilityClass,
  LlmOperation,
  MeteredEmbedOperation,
  MeteredGenerationOperation,
  MeteredJudgmentOperation,
} from './operations.js'
export {
  assertMeteredOperationsRegistered,
  capabilityClassForOperation,
  LlmOperationNotRegisteredError,
  llmOperations,
  METERED_EMBED_OPERATIONS,
  METERED_GENERATION_OPERATIONS,
  METERED_JUDGMENT_OPERATIONS,
  maxCostUsdForOperation,
  maxRegisteredCostUsd,
} from './operations.js'
export type {
  CompleteOptions,
  CompletionResult,
  CompletionUsage,
  DecideAnswer,
  DecideQuestion,
  DecideRequest,
  DecideResult,
  EmbedResult,
  EmbedUsage,
  Gateway,
} from './types.js'
export { EMBEDDING_DIMENSIONS } from './types.js'
