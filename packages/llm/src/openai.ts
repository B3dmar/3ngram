// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible Gateway ("bring your own gateway").
//
// A minimal, REAL implementation of the {@link Gateway} interface over the
// OpenAI `/embeddings` and `/chat/completions` REST shapes (which every
// self-hostable gateway — LiteLLM, vLLM, the OpenAI API itself — speaks).
// fetch-based (node builtin): ZERO new dependencies, honouring the supply-chain
// posture (AGENTS.md hard rule 7).
//
// SCOPE. embed() is what core search() needs to function. complete() was a
// NotImplementedError stub until a tool needed generation; the session closer
// (docs/concepts/session-continuity.mdx layer 5) is that tool, so it is
// implemented here rather than duplicated into apps/worker — a provider call
// outside packages/llm is a build failure (scripts/check-no-direct-provider.sh).
// Constructed by the app ONLY when the gateway env is configured (env-gated,
// like OAuth); when absent the MCP search tool surfaces a typed "embedding
// gateway not configured" error, remember() runs with embedding off, and the
// closer stays inert.
//
// Observability (hard rule 6): NO key material and NO text content enters any
// log or error message. This module logs nothing; the only error it raises names
// the HTTP status, never the request/response body.
import { EMBEDDING_DIMENSIONS, type EmbedResult, type Gateway } from './types.js'

/** The embedding model + dimensionality the schema is built around. */
export const EMBEDDING_MODEL = 'text-embedding-3-large'

/**
 * Default generation model for {@link Gateway.complete}. Small and cheap on
 * purpose: the only production generation caller is the session closer, whose
 * job is a bounded classification ("which of these briefed ids did the work
 * complete?"), not open-ended prose. Overridable per deployment via
 * `completionModel`.
 */
export const COMPLETION_MODEL = 'gpt-4o-mini'

/** Resolved config for the OpenAI-compatible gateway. */
export interface OpenAIGatewayConfig {
  /** Base URL of the gateway (no trailing slash), e.g. https://api.openai.com/v1. */
  baseUrl: string
  /** Bearer credential. NEVER logged. */
  apiKey: string
  /** Override the embedding model; defaults to {@link EMBEDDING_MODEL}. */
  model?: string
  /** Override the generation model; defaults to {@link COMPLETION_MODEL}. */
  completionModel?: string
  /** Request timeout in ms (HTTP calls must be bounded). Defaults to 30s. */
  timeoutMs?: number
}

/**
 * Raised when a not-yet-implemented gateway operation is invoked. No operation
 * on this gateway raises it today ({@link createOpenAIGateway} implements both
 * `embed` and `complete`); it is kept as the typed shape a future operation
 * declares itself unimplemented with, and because callers already discriminate
 * on it.
 */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`gateway operation not implemented: ${operation}`)
    this.name = 'NotImplementedError'
  }
}

/**
 * Raised when a generation response is structurally wrong — no choice, or a
 * choice with no text. Counts only in the message, never the prompt or the
 * partial completion (hard rule 6). A caller that strict-parses the completion
 * must be able to tell "the gateway returned nothing" from "the model returned
 * something I rejected"; collapsing both into an empty string hid the first.
 */
export class InvalidCompletionResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCompletionResponseError'
  }
}

/**
 * Raised when the gateway HTTP call fails. The message carries the operation and
 * HTTP status ONLY — never the response body, the request texts, or the api key
 * (hard rule 6: a provider error must not leak content or credentials).
 *
 * The status is ALSO exposed as a `status` property so failure classifiers can
 * persist it as a bounded code (core classifyEmbedFailure reads `code ?? status`).
 * Without it every gateway HTTP failure collapses into the same audit label —
 * "GatewayRequestError (msg len 36)" — and a 400 (bad input, deterministic) is
 * indistinguishable from a 429 (rate limit, transient) in the embed_failed
 * trail. That ambiguity is exactly what made such failures undiagnosable post-hoc.
 */
export class GatewayRequestError extends Error {
  readonly status: number
  constructor(operation: string, status: number) {
    super(`gateway ${operation} failed with status ${status}`)
    this.name = 'GatewayRequestError'
    this.status = status
  }
}

/**
 * Raised when a gateway embedding response is structurally wrong: the row count
 * does not match the request, or a returned vector has the wrong dimensionality.
 * The message carries COUNTS and LENGTHS only — never the request texts or the
 * vector contents (hard rule 6: a provider error must not leak content). A
 * malformed embedding silently stored at the wrong width would corrupt every
 * later cosine search, so the gateway fails loud at the boundary.
 */
export class InvalidEmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEmbeddingResponseError'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Strip trailing path separators in linear time for arbitrary config input. */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
  // Token accounting for cost tracking. Carries no content —
  // counts only. Absent on some self-hosted gateways; defaulted to 0.
  usage?: { prompt_tokens?: number }
  // The model the gateway actually served; falls back to the requested model.
  model?: string
}

/**
 * Construct an OpenAI-compatible embedding gateway. Pure factory — no I/O at
 * construction; the network call happens per embed().
 */
export function createOpenAIGateway(config: OpenAIGatewayConfig): Gateway {
  const baseUrl = stripTrailingSlashes(config.baseUrl)
  const model = config.model ?? EMBEDDING_MODEL
  const completionModel = config.completionModel ?? COMPLETION_MODEL
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function embed(texts: readonly string[], _operation: string): Promise<EmbedResult> {
    if (texts.length === 0) return { embeddings: [], usage: { inputTokens: 0 }, model }
    // Bound the call: an HTTP request without a timeout is a hang risk.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      // Drain the body so the socket can be reused; discard it (never logged).
      await response.text().catch(() => undefined)
      throw new GatewayRequestError('embed', response.status)
    }
    const payload = (await response.json()) as EmbeddingResponse
    const rows = payload.data ?? []
    // A gateway that returns the wrong row count or a wrong-width vector would
    // poison every later cosine search if stored. Validate counts/lengths at the
    // boundary and fail loud (counts/lengths only in the message — never content).
    if (rows.length !== texts.length) {
      throw new InvalidEmbeddingResponseError(
        `embedding response row count ${rows.length} != request count ${texts.length}`,
      )
    }
    const embeddings = rows.map((row, index) => {
      const vector = row.embedding ?? []
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new InvalidEmbeddingResponseError(
          `embedding row ${index} has dimension ${vector.length} != expected ${EMBEDDING_DIMENSIONS}`,
        )
      }
      return vector
    })
    // Surface token usage for cost tracking: counts only, never
    // content. A gateway that omits usage yields 0 (cost is then recorded as 0).
    return {
      embeddings,
      usage: { inputTokens: payload.usage?.prompt_tokens ?? 0 },
      model: payload.model ?? model,
    }
  }

  /**
   * One generation round-trip over the OpenAI-compatible `/chat/completions`
   * shape — the same REST surface every self-hostable gateway (LiteLLM, vLLM,
   * the OpenAI API) speaks, so "bring your own gateway" still holds.
   *
   * `temperature: 0` because the only production caller is a classification
   * pass whose output is strict-parsed against a schema; sampling variance
   * there is not creativity, it is flake.
   *
   * Same observability contract as embed(): the prompt carries tenant content,
   * so neither it nor the completion nor the response body may enter a log line
   * or an error message. {@link GatewayRequestError} names the status only.
   */
  async function complete(prompt: string, _operation: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: completionModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      await response.text().catch(() => undefined)
      throw new GatewayRequestError('complete', response.status)
    }
    const payload = (await response.json()) as CompletionResponse
    const text = payload.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new InvalidCompletionResponseError(
        `completion response has ${payload.choices?.length ?? 0} choices with no text content`,
      )
    }
    return text
  }

  return { embed, complete }
}
