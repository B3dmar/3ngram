// SPDX-License-Identifier: Apache-2.0
// Ack-before-embed.
//
// remember()/revise() ACK the caller BEFORE any embedding round-trip — the
// synchronous write path never blocks on the LLM. AFTER the ack, this module
// kicks an async embed via the INJECTED Gateway (core never constructs
// providers or reads env; FakeGateway in tests, no network in CI) and lands the
// vector via the narrow db helper. The embedding is DERIVED METADATA, not
// content (docs/concepts/memory-model.mdx untouched).
//
// CONTRACT (all four are load-bearing):
//   1. The embed task NEVER throws into the caller — on any failure it records
//      an `embed_failed` audit event and logs a redacted warning, then resolves.
//   2. It is NEVER fire-and-forget without a `.catch` — the kicked promise is
//      defended so an unhandled rejection can never escape.
//   3. It is AWAITABLE in tests via the returned handle, so tests assert the
//      ack happens BEFORE settle without sleeping.
//   4. With no gateway, behaviour is byte-for-byte today's: embedding stays NULL.
//
// Observability (hard rule 6): the source text and the vector are content-
// derived — never logged. We log the memory id and the vector LENGTH only. The
// failure path NEVER persists or logs the gateway's raw error message — provider
// errors routinely quote the offending input text. Instead we classify the error
// into a bounded label ("<name>[:<code>] (msg len <n>)") via classifyEmbedFailure;
// no free-form provider text ever reaches the payload or the logs.
import { insertLlmUsage, recordEmbedFailure, updateMemoryEmbedding } from '@3ngram/db'
import type { EmbedResult, Gateway } from '@3ngram/llm'
import type { ActorKind } from '@3ngram/schema'
import {
  type AccessGate,
  type BudgetEnforcement,
  type BudgetReservationHandle,
  type LimitsResolver,
  releaseBudgetReservation,
  reserveBudgetSlot,
} from '../budget/index.js'

/** Default Gateway operation key for write-path embeddings (Gateway.embed(texts, op)). */
export const EMBED_OPERATION = 'memory.embed'

/**
 * CONFIGURABLE per-model embedding price, USD PER INPUT TOKEN.
 *
 * No price constant existed in the repo; this is the single source of truth for
 * embedding cost. Rates are list prices as of 2026-06 and SHOULD be revisited
 * when the provider changes pricing or a new embedding model is adopted — they
 * are intentionally a static map, not env-driven, so a price change is a
 * reviewed code change with a clear diff. Unknown models record cost_usd = NULL
 * (tokens are still tracked) rather than guessing.
 *
 * OpenAI list price: text-embedding-3-large $0.13 / 1M tokens, -3-small
 * $0.02 / 1M tokens, ada-002 $0.10 / 1M tokens.
 */
export const EMBEDDING_PRICE_USD_PER_TOKEN: Readonly<Record<string, number>> = {
  'text-embedding-3-large': 0.13 / 1_000_000,
  'text-embedding-3-small': 0.02 / 1_000_000,
  'text-embedding-ada-002': 0.1 / 1_000_000,
}

/** Default embedding model used for cost lookup when the gateway omits a model. */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large'

/**
 * Compute cost_usd for an embedding call from its input tokens and model.
 * Returns null for an unknown model so cost stays HONEST (NULL = unpriced)
 * rather than silently zero. output_tokens is always 0 for embeddings.
 */
export function embeddingCostUsd(model: string, inputTokens: number): number | null {
  const rate = EMBEDDING_PRICE_USD_PER_TOKEN[model]
  if (rate === undefined) return null
  return inputTokens * rate
}

/**
 * Ceiling on the EMBED INPUT, not the stored content. Import-path content may
 * run to 256K chars (frozen-mapping blobs), but embedding models bound their
 * input tokens (text-embedding-3-large: 8,191) — an unbounded input gets a 400
 * from the provider and the memory lands embed_failed instead of searchable.
 * Oversized content is truncated for the embedding round-trip ONLY; the stored
 * row keeps the whole body (the vector is derived metadata, docs/concepts/memory-model.mdx).
 */
export const MAX_EMBED_INPUT_LENGTH = 8000

/**
 * Bounded, content-free reason recorded when the embed input normalizes to
 * empty (zero-length or whitespace-only). The provider deterministically 400s
 * an empty string ("input cannot be an empty string" — verified live against
 * the OpenAI /embeddings endpoint), so the gateway is never called:
 * the memory lands a deterministic `embed_failed` event with this reason
 * instead of burning a doomed round-trip. Schema-validated writes cannot
 * produce empty content (write.ts `.trim().min(1)`), so this guard protects
 * non-schema callers (repair/backfill paths, future facades).
 */
export const EMPTY_EMBED_INPUT_REASON = 'empty_input'

/**
 * Minimal pino-shaped logger surface (obj-then-msg). Transports INJECT the
 * configured pino logger (packages/config); core never imports a logger or
 * console (the no-console lint rule + layering). When none is injected the
 * failure is still durably recorded as an `embed_failed` audit event — the log
 * is a redacted convenience, the event is the source of truth.
 */
export interface EmbedLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

/** No-op logger: core's default when the caller injects none (see EmbedLogger). */
const noopLogger: EmbedLogger = { warn: () => {} }

/**
 * Bound a classification code so a misbehaving provider can't smuggle the input
 * text out via an `error.code`/`status` field. Codes are short identifiers
 * (SQLSTATE, HTTP status, provider error codes) — anything longer or non-scalar
 * is dropped.
 */
const MAX_CODE_LENGTH = 32

function extractCode(error: Error): string | undefined {
  const candidate =
    (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  if (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= MAX_CODE_LENGTH
  ) {
    // Only emit codes that look like identifiers, never free-form text.
    return /^[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : undefined
  }
  return undefined
}

/**
 * Classify an embed failure into a bounded, content-free label safe to persist
 * and log (hard rule 6). The RAW error message is NEVER included — only the
 * error name, an optional identifier-shaped code, and the message LENGTH:
 *   "<name>[:<code>] (msg len <n>)"  e.g. "Error:429 (msg len 137)".
 */
export function classifyEmbedFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    const value = String(error)
    return `NonError (value len ${value.length})`
  }
  const name = error.name || 'Error'
  const code = extractCode(error)
  const codePart = code ? `:${code}` : ''
  return `${name}${codePart} (msg len ${error.message.length})`
}

/** Options that turn on best-effort embed-on-write. All optional. */
export interface EmbedOptions {
  /** Injected Gateway. When absent, no embed is attempted (embedding NULL). */
  gateway?: Gateway | undefined
  /** Injected logger for the redacted failure warning. Defaults to a no-op. */
  logger?: EmbedLogger | undefined
  /** Gateway operation key for cost attribution (an injected config knob like
   * the gateway itself, not user data). Defaults to 'memory.embed'; the import
   * facade attributes its batches under 'import.embed'. */
  operation?: string | undefined
  /** Injected budget enforcement. When present, the SHARED embed seam
   * asserts the cap before the gateway round-trip, so EVERY write-embed caller —
   * remember/revise/import AND repair — is capped, not only the entry
   * points that pre-check. Absent → no budget gate (back-compat). */
  budget?: BudgetEnforcement | undefined
  /** Injected access gate. Threaded INDEPENDENTLY of the metered-embed `budget`
   * so the write access guard (`assertWrite`) runs on EVERY write — including the
   * embeddings-off path, where transports pass no gateway/budget. Absent → no
   * access guard (self-host allowAllAccess, when wired, is a true no-op anyway). */
  access?: AccessGate | undefined
  /** Injected resource-limit policy. Omitted values are unlimited. */
  limits?: LimitsResolver | undefined
}

/**
 * The async embed task body: embed the text, land the vector, or record a
 * failure. NEVER throws — every error path is caught and turned into an
 * `embed_failed` audit event plus a redacted warning. Returns whether the
 * embedding landed (false on any failure or a vanished/superseded row).
 */
/**
 * Land ONE `llm_usage` row for an embed() call (the client
 * tracks cost). Computes cost_usd from the surfaced token usage + model, then
 * writes through the RLS-scoped db helper. Best-effort: a failure to record cost
 * MUST NOT break the embed (the vector is the user-facing JTBD), so it is caught
 * and logged with a content-free reason. Records counts/cost/operation/model
 * ONLY — never the embedded text or the vector (hard rule 6).
 */
async function recordEmbedUsage(
  userId: string,
  operation: string,
  result: EmbedResult,
  logger: EmbedLogger,
): Promise<void> {
  const model = result.model || DEFAULT_EMBEDDING_MODEL
  const inputTokens = result.usage.inputTokens
  try {
    await insertLlmUsage(userId, {
      operation,
      model,
      inputTokens,
      outputTokens: 0,
      costUsd: embeddingCostUsd(model, inputTokens),
    })
  } catch (error) {
    logger.warn(
      { operation, model, reason: classifyEmbedFailure(error) },
      'embed cost usage row could not be recorded',
    )
  }
}

async function runEmbed(
  userId: string,
  memoryId: string,
  text: string,
  actorKind: ActorKind,
  gateway: Gateway,
  logger: EmbedLogger,
  operation: string,
  budget: BudgetEnforcement | undefined,
): Promise<boolean> {
  // SHARED SEAM budget gate: ATOMICALLY reserve the
  // cap BEFORE the gateway round-trip so no metered embed path escapes it AND
  // concurrent near-cap calls cannot all pass and overshoot. Over cap →
  // BudgetExceededError is caught below and recorded as a content-free
  // embed_failed event (spend never incurred; repair/backfill retries when back
  // under cap). The reservation is released in `finally` once the call settles.
  let reservation: BudgetReservationHandle | undefined
  try {
    if (budget) reservation = await reserveBudgetSlot(budget, userId, operation)
    const result = await gateway.embed([text], operation)
    // Record cost for the call once it returned — the spend was incurred even if
    // the vector cannot land (the row was superseded mid-flight). Exactly ONE
    // usage row per embed() call (not per text); never blocks/breaks the embed.
    await recordEmbedUsage(userId, operation, result, logger)
    const [vector] = result.embeddings
    if (!vector) throw new Error('gateway returned no embedding')
    const landed = await updateMemoryEmbedding(userId, memoryId, vector)
    return landed
  } catch (error) {
    // Classify into a bounded, content-free label — the raw provider message can
    // quote the offending input text and must never be persisted or logged.
    const reason = classifyEmbedFailure(error)
    // Best-effort: a failure to RECORD the failure must also not throw into the
    // caller (the write already ACKed). Swallow it after logging.
    await recordEmbedFailure(userId, memoryId, actorKind, reason).catch((recordError) => {
      logger.warn(
        { memoryId, recordError: classifyEmbedFailure(recordError) },
        'embed failure event could not be recorded',
      )
    })
    // id + classified reason only — never the source text or the vector (hard rule 6).
    logger.warn({ memoryId, reason }, 'memory embedding failed; recorded embed_failed event')
    return false
  } finally {
    // Always release the in-flight reservation once the call settles (the actual
    // cost, if any, is now in llm_usage). No-op when the gate failed open or
    // rejected (no reservation was taken).
    if (reservation) await releaseBudgetReservation(userId, reservation)
  }
}

/**
 * Deterministic empty-input failure path: record the `embed_failed` event with
 * the bounded {@link EMPTY_EMBED_INPUT_REASON} and resolve false — no gateway
 * call. Mirrors runEmbed's contract exactly: never throws (a failure to record
 * is logged and swallowed; the caller was already ACKed).
 */
async function recordEmptyInput(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
  logger: EmbedLogger,
): Promise<boolean> {
  // async so a SYNCHRONOUSLY throwing recorder becomes a rejection contained
  // here (and by the kickEmbed guard), never a throw into the caller.
  await recordEmbedFailure(userId, memoryId, actorKind, EMPTY_EMBED_INPUT_REASON).catch(
    (recordError) => {
      logger.warn(
        { memoryId, recordError: classifyEmbedFailure(recordError) },
        'embed failure event could not be recorded',
      )
    },
  )
  // id + bounded reason only — never the input text (hard rule 6).
  logger.warn(
    { memoryId, reason: EMPTY_EMBED_INPUT_REASON },
    'embed input empty after trim; recorded embed_failed event without a gateway call',
  )
  return false
}

/**
 * Kick the embed task AFTER the caller has been ACKed. Returns a handle whose
 * `settled` promise resolves when the task finishes (true = embedding landed) —
 * tests await it; production may ignore it. When no gateway is injected the
 * handle resolves false immediately and NO embed is attempted.
 *
 * The returned promise is internally `.catch`-defended (the task never throws,
 * but defence-in-depth guarantees no unhandled rejection can ever escape — hard
 * rule on fire-and-forget async).
 */
export function kickEmbed(
  userId: string,
  memoryId: string,
  text: string,
  actorKind: ActorKind,
  options: EmbedOptions,
): { settled: Promise<boolean> } {
  if (!options.gateway) return { settled: Promise.resolve(false) }
  const logger = options.logger ?? noopLogger
  const gateway = options.gateway
  const operation = options.operation ?? EMBED_OPERATION
  // Empty-after-trim input: the provider 400s it deterministically, so
  // record the failure WITHOUT a gateway call. Same contract as runEmbed: never
  // throws, settles false, the embed_failed event is the durable signal.
  if (text.trim().length === 0) {
    // Same outer guard as the runEmbed path below: recordEmptyInput never
    // throws by design, but a misbehaving injected recorder/logger must not be
    // able to reject `settled` (production callers may ignore the handle).
    const settled = recordEmptyInput(userId, memoryId, actorKind, logger).catch((error) => {
      logger.warn(
        { memoryId, reason: classifyEmbedFailure(error) },
        'embed task rejected unexpectedly',
      )
      return false
    })
    return { settled }
  }
  // Bound the EMBED INPUT only (see MAX_EMBED_INPUT_LENGTH) — the stored
  // content is untouched; oversized bodies still get a usable prefix vector.
  const embedInput =
    text.length > MAX_EMBED_INPUT_LENGTH ? text.slice(0, MAX_EMBED_INPUT_LENGTH) : text
  // runEmbed never throws, but the .catch is the explicit fire-and-forget guard.
  const settled = runEmbed(
    userId,
    memoryId,
    embedInput,
    actorKind,
    gateway,
    logger,
    operation,
    options.budget,
  ).catch((error) => {
    logger.warn(
      { memoryId, reason: classifyEmbedFailure(error) },
      'embed task rejected unexpectedly',
    )
    return false
  })
  return { settled }
}
