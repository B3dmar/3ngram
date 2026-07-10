// SPDX-License-Identifier: Apache-2.0
/** Token accounting surfaced from an embed() round-trip for cost tracking.
 * Embeddings have NO output tokens (the vector is not billed as
 * generation), so only the prompt/input token count is carried; the caller
 * (packages/core) maps it to an `llm_usage` row. NEVER carries content. */
export interface EmbedUsage {
  /** Prompt tokens billed for the batch (OpenAI `usage.prompt_tokens`). */
  inputTokens: number
}

/** Result of a single embed() round-trip: the per-text vectors plus the batch
 * token usage and the model that produced them, so the client module can record
 * exactly one cost row per call (the client tracks cost, the gateway
 * stays thin). */
export interface EmbedResult {
  /** One vector per input text, in request order. */
  embeddings: number[][]
  /** Batch-level token accounting (no per-text breakdown). */
  usage: EmbedUsage
  /** The model that produced the embeddings (used for the cost rate lookup). */
  model: string
}

/** Gateway client surface. Layers 1–4 of the test pyramid only
 * ever see this interface — never a real provider (docs/concepts/testing.mdx LLM policy). */
export interface Gateway {
  embed(texts: readonly string[], operation: string): Promise<EmbedResult>
  complete(prompt: string, operation: string): Promise<string>
}

export const EMBEDDING_DIMENSIONS = 1536
