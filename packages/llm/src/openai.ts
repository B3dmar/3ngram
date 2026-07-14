// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible embedding Gateway ("bring your own gateway").
//
// A minimal, REAL implementation of the {@link Gateway} interface over the
// OpenAI `/embeddings` REST shape (which every self-hostable gateway — LiteLLM,
// vLLM, the OpenAI API itself — speaks). fetch-based (node builtin): ZERO new
// dependencies, honouring the supply-chain posture (AGENTS.md hard rule 7).
//
// SCOPE (Phase 2D D0): only embed() is implemented — it is what core search()
// needs to function. complete() throws NotImplementedError; it lands when a tool
// needs generation (consolidation/judge are eval-side). Constructed by the app
// ONLY when the gateway env is configured (env-gated, like OAuth); when absent
// the MCP search tool surfaces a typed "embedding gateway not configured" error
// and remember() runs with embedding off.
//
// Observability (hard rule 6): NO key material and NO text content enters any
// log or error message. This module logs nothing; the only error it raises names
// the HTTP status, never the request/response body.
import { EMBEDDING_DIMENSIONS, type EmbedResult, type Gateway } from './types.js'

/** The embedding model + dimensionality the schema is built around. */
export const EMBEDDING_MODEL = 'text-embedding-3-large'

/** Resolved config for the OpenAI-compatible gateway. */
export interface OpenAIGatewayConfig {
  /** Base URL of the gateway (no trailing slash), e.g. https://api.openai.com/v1. */
  baseUrl: string
  /** Bearer credential. NEVER logged. */
  apiKey: string
  /** Override the embedding model; defaults to {@link EMBEDDING_MODEL}. */
  model?: string
  /** Request timeout in ms (HTTP calls must be bounded). Defaults to 30s. */
  timeoutMs?: number
}

/** Raised when a not-yet-implemented gateway operation is invoked (D0: complete). */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`gateway operation not implemented: ${operation}`)
    this.name = 'NotImplementedError'
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

  function complete(_prompt: string, _operation: string): Promise<string> {
    return Promise.reject(new NotImplementedError('complete'))
  }

  return { embed, complete }
}
