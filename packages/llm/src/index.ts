// SPDX-License-Identifier: Apache-2.0

export type { FakeGatewayOptions } from './fake.js'
export { createFakeGateway, FAKE_EMBEDDING_MODEL, fakeEmbedding } from './fake.js'
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
} from './operations.js'
export {
  assertMeteredOperationsRegistered,
  capabilityClassForOperation,
  LlmOperationNotRegisteredError,
  llmOperations,
  METERED_EMBED_OPERATIONS,
  METERED_GENERATION_OPERATIONS,
  maxCostUsdForOperation,
  maxRegisteredCostUsd,
} from './operations.js'
export type { EmbedResult, EmbedUsage, Gateway } from './types.js'
export { EMBEDDING_DIMENSIONS } from './types.js'
