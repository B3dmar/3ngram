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
  /**
   * Token accounting, ABSENT when the gateway reported none.
   *
   * Optional on purpose: "the gateway said zero" and "the gateway said nothing"
   * must not collapse into the same value. Defaulting a missing `usage` to zero
   * would price the call at $0 and let a usage-omitting gateway run without ever
   * accruing against a budget cap. A caller that cannot see real counts should
   * record the row UNPRICED so the conservative fallback applies.
   */
  usage?: CompletionUsage | undefined
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

/**
 * One typed judgment question (issue #225). The three kinds are the judgment
 * provider's primitives, kept wire-shaped so the provider maps them 1:1:
 *   - `noul`   — yes/no; answered with P(yes).
 *   - `choice` — pick one label; `criteria` maps each label to its description.
 *   - `score`  — an ordered rubric, index 0 upward; at least two levels.
 * Every string here may carry tenant-derived text: never logged.
 */
export type DecideQuestion =
  | {
      type: 'noul'
      instructions: string
      criteria?: { true?: string | undefined; false?: string | undefined } | undefined
    }
  | { type: 'choice'; instructions: string; criteria: Readonly<Record<string, string | null>> }
  | { type: 'score'; instructions: string; criteria: readonly string[] }

/**
 * A judgment request: one bounded `state` every question is answered against,
 * plus the questions keyed by the name their answer comes back under. The
 * question names ARE the answer id space, so an answer for anything not asked is
 * unrepresentable once the provider has validated the response.
 */
export interface DecideRequest {
  /** The text the questions are judged against. Tenant-derived: never logged. */
  state: string
  questions: Readonly<Record<string, DecideQuestion>>
}

/** A typed answer. Every probability and confidence is in [0, 1]. */
export type DecideAnswer =
  | { type: 'noul'; probability: number }
  | {
      type: 'choice'
      choice: string
      confidence: number
      probabilities: Readonly<Record<string, number>>
    }
  | {
      type: 'score'
      /** Expected score; may fall between integer rubric levels. */
      score: number
      confidence: number
      probabilities: Readonly<Record<string, number>>
    }

/**
 * Result of one decide() round-trip: an answer per asked question, plus the
 * accounting the caller needs for exactly one `llm_usage` row. `usage` is
 * optional for the reason {@link CompletionResult.usage} is: a provider that
 * reports no input count must leave the row UNPRICED, never price it at $0.
 */
export interface DecideResult {
  answers: Readonly<Record<string, DecideAnswer>>
  usage?: CompletionUsage | undefined
  model: string
}

/** Gateway client surface. Layers 1–4 of the test pyramid only
 * ever see this interface — never a real provider (docs/concepts/testing.mdx LLM policy). */
export interface Gateway {
  embed(texts: readonly string[], operation: string): Promise<EmbedResult>
  complete(prompt: string, operation: string, options?: CompleteOptions): Promise<CompletionResult>
  /**
   * Typed judgments over bounded state (issue #225). A provider without the
   * capability throws `NotImplementedError`; that typed rejection, not a crash,
   * is what "no judgment provider configured" looks like to a caller.
   */
  decide(request: DecideRequest, operation: string): Promise<DecideResult>
}

export const EMBEDDING_DIMENSIONS = 1536
