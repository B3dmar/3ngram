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

/** Token accounting for one generation round-trip. Unlike an embedding, a
 * completion bills BOTH directions, so the caller needs the pair to price it.
 * NEVER carries content. */
export interface CompletionUsage {
  inputTokens: number
  outputTokens: number
}

/** Result of a single complete() round-trip: the text plus the accounting the
 * caller needs to write exactly one `llm_usage` row (the client tracks cost, the
 * gateway stays thin — the same split embed() already uses). */
export interface CompletionResult {
  /** The model's reply. Derived from tenant input: never logged. */
  text: string
  usage: CompletionUsage
  /** The model that served it (used for the cost-rate lookup). */
  model: string
}

/** Bound on a completion's OUTPUT tokens. Passed per call so a runaway
 * generation cannot turn a bounded classification into an unbounded bill. */
export interface CompleteOptions {
  maxOutputTokens?: number | undefined
  /** Ask the provider to constrain the reply to a JSON object, where supported. */
  jsonObject?: boolean | undefined
}

/** Gateway client surface. Layers 1–4 of the test pyramid only
 * ever see this interface — never a real provider (docs/concepts/testing.mdx LLM policy). */
export interface Gateway {
  embed(texts: readonly string[], operation: string): Promise<EmbedResult>
  complete(prompt: string, operation: string, options?: CompleteOptions): Promise<CompletionResult>
}

export const EMBEDDING_DIMENSIONS = 1536
