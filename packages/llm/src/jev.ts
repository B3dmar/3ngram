// SPDX-License-Identifier: Apache-2.0
// Jev (TypeSafe AI) judgment gateway — the `decide()` provider (issue #225).
//
// Raw fetch, ZERO dependencies, mirroring openai.ts (AGENTS.md hard rule 7): the
// vendor SDK (`@typesafe-ai/sdk`) is pre-1.0 and proprietary-adjacent, so this
// file speaks its wire contract directly instead. CONTRACT SOURCE: the published
// `@typesafe-ai/sdk@0.7.0` type declarations and client (`POST /v1/systemone`,
// Bearer auth, body `{state, questions, model}` → `{model, answers, usage}`),
// checked against a recorded live response for the pin `jev-1.14.0` on
// 2026-10-25 (test/__fixtures__/jev-systemone-recorded.json).
// The SDK retries and logs bodies at debug level; this client does neither —
// one bounded attempt, and no body (request or response) ever reaches a log
// line or an error message (hard rule 6).
//
// MODEL PIN. `model` is required and sent on every call: the vendor's
// `jev-latest` alias would let the judged distribution change under a fixed
// threshold without any change on our side. The factory refuses an alias
// (isFloatingModelAlias), and packages/config refuses one at env load.
//
// Only `decide()` exists here. `embed()` and `complete()` throw
// NotImplementedError; composeGateway (compose.ts) routes those to the
// OpenAI-compatible gateway.
import { GatewayRequestError, NotImplementedError } from './openai.js'
import type {
  DecideAnswer,
  DecideQuestion,
  DecideRequest,
  DecideResult,
  EmbedResult,
  Gateway,
} from './types.js'

/** Default API root (the vendor's documented default). */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai'

/** Per-call bound on `state`, in characters. The vendor's state budget is 32K
 * tokens; 64K characters stays well inside it, and the closer sends ~4K. */
export const MAX_DECIDE_STATE_CHARS = 64_000

/** Per-call bound on the question count. The closer briefs at most 100 rows. */
export const MAX_DECIDE_QUESTIONS = 100

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * True for a model name that floats rather than pins: `latest`, or anything
 * ending in a separator then `latest` (`jev-latest`, `jev_latest`, `jev.latest`,
 * `jev:latest`). packages/config applies the same rule at env load.
 */
export function isFloatingModelAlias(model: string): boolean {
  return /(^|[-_.@:])latest$/i.test(model.trim())
}

/** Resolved config for the Jev gateway. */
export interface JevGatewayConfig {
  /** API root without the `/v1` path; defaults to {@link JEV_DEFAULT_BASE_URL}. */
  baseUrl?: string | undefined
  /** Bearer credential. NEVER logged. */
  apiKey: string
  /** Explicit model pin, sent on every call (never an alias like `jev-latest`). */
  model: string
  /** Request timeout in ms, covering headers AND body. Defaults to 10s. */
  timeoutMs?: number
}

/**
 * Raised when a decide() request is out of bounds before any network call, or a
 * response does not match the questions asked. Counts, names of KINDS and
 * indexes only — never state, instructions, labels or response text.
 */
export class InvalidDecideError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDecideError'
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Reject an out-of-bounds request before it costs a network round-trip. */
export function assertDecideRequest(request: DecideRequest): void {
  if (request.state.length === 0 || request.state.length > MAX_DECIDE_STATE_CHARS) {
    throw new InvalidDecideError(
      `decide state length ${request.state.length} outside 1..${MAX_DECIDE_STATE_CHARS}`,
    )
  }
  const entries = Object.entries(request.questions)
  if (entries.length === 0 || entries.length > MAX_DECIDE_QUESTIONS) {
    throw new InvalidDecideError(
      `decide question count ${entries.length} outside 1..${MAX_DECIDE_QUESTIONS}`,
    )
  }
  for (const [index, [, question]] of entries.entries()) {
    if (question.type === 'choice' && Object.keys(question.criteria).length === 0) {
      throw new InvalidDecideError(`decide question ${index} (choice) has no labels`)
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new InvalidDecideError(`decide question ${index} (score) has fewer than 2 levels`)
    }
  }
}

/**
 * Probabilities keyed by label (or score index), each in [0, 1], over EXACTLY
 * the `allowed` keys — the vendor contract types this as a total map, and a
 * caller reading `probabilities[label]` must never get undefined. Built with
 * Object.fromEntries so a `__proto__` label lands as an own key.
 */
function readProbabilities(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length !== allowed.size) return undefined
  for (const [key, p] of entries) {
    if (!allowed.has(key) || !isUnit(p)) return undefined
  }
  return Object.fromEntries(entries) as Record<string, number>
}

/** Validate one wire answer against the question it answers; undefined = invalid. */
function readAnswer(question: DecideQuestion, wire: unknown): DecideAnswer | undefined {
  if (!isRecord(wire) || wire.type !== question.type) return undefined
  if (question.type === 'noul') {
    return isUnit(wire.noul) ? { type: 'noul', probability: wire.noul } : undefined
  }
  if (!isUnit(wire.confidence)) return undefined
  if (question.type === 'choice') {
    const labels = new Set(Object.keys(question.criteria))
    const probabilities = readProbabilities(wire.probabilities, labels)
    if (typeof wire.choice !== 'string' || !labels.has(wire.choice) || !probabilities) {
      return undefined
    }
    return { type: 'choice', choice: wire.choice, confidence: wire.confidence, probabilities }
  }
  const levels = new Set(question.criteria.map((_, i) => String(i)))
  const probabilities = readProbabilities(wire.probabilities, levels)
  const top = question.criteria.length - 1
  const score = wire.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > top) {
    return undefined
  }
  if (!probabilities) return undefined
  return { type: 'score', score, confidence: wire.confidence, probabilities }
}

/**
 * Validate a `/v1/systemone` body against the request. The answer set must be
 * EXACTLY the question set: a missing answer, an extra key, a type mismatch, an
 * unknown label or an out-of-range number all fail the whole call. Messages
 * carry counts and positions only.
 */
export function parseDecideResponse(request: DecideRequest, payload: unknown): DecideResult {
  const model = isRecord(payload) ? payload.model : undefined
  if (!isRecord(payload) || !isRecord(payload.answers) || typeof model !== 'string' || !model) {
    throw new InvalidDecideError('decide response is not an object with answers and model')
  }
  const wireAnswers = payload.answers
  const names = Object.keys(request.questions)
  const extra = Object.keys(wireAnswers).filter((key) => !Object.hasOwn(request.questions, key))
  if (extra.length > 0) {
    throw new InvalidDecideError(`decide response has ${extra.length} unasked answers`)
  }
  // Own-key reads and Object.fromEntries: a question named `__proto__` must be
  // answered by an own key and land as one, never touch a prototype.
  const answered = names.map((name, index): [string, DecideAnswer] => {
    const question = request.questions[name] as DecideQuestion
    const wire = Object.hasOwn(wireAnswers, name) ? wireAnswers[name] : undefined
    const answer = readAnswer(question, wire)
    if (answer === undefined) {
      throw new InvalidDecideError(`decide answer ${index} (${question.type}) missing or invalid`)
    }
    return [name, answer]
  })
  return { answers: Object.fromEntries(answered), ...readUsage(payload.usage), model }
}

/** Usage counts. An absent or invalid input count yields NO usage (unpriced),
 * never zero. Output is billed free by the vendor, so an absent or invalid output
 * count reads 0 rather than discarding the billed input count with it. */
function readUsage(value: unknown): Pick<DecideResult, 'usage'> {
  if (!isRecord(value) || !isCount(value.input_tokens)) return {}
  const output = isCount(value.output_tokens) ? value.output_tokens : 0
  return { usage: { inputTokens: value.input_tokens, outputTokens: output } }
}

function notImplemented(operation: string): Promise<never> {
  return Promise.reject(new NotImplementedError(operation))
}

/**
 * Construct the Jev judgment gateway. Pure factory — no I/O at construction.
 * One attempt per call, no retries: the caller (a BullMQ job) owns retry policy,
 * and a hidden retry would double-spend against a reservation made for one call.
 */
export function createJevGateway(config: JevGatewayConfig): Gateway {
  // Config errors name the field, never its value.
  if (config.model.trim() === '' || isFloatingModelAlias(config.model)) {
    throw new Error('Jev gateway model must pin a version, not an alias like jev-latest')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Jev gateway timeoutMs must be a positive number')
  }
  const url = `${stripTrailingSlashes(config.baseUrl ?? JEV_DEFAULT_BASE_URL)}/v1/systemone`

  async function decide(request: DecideRequest, _operation: string): Promise<DecideResult> {
    assertDecideRequest(request)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // Armed until the BODY is read, as in openai.ts complete(): a stall after the
    // headers must still be interrupted.
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        // Our question shapes ARE the wire shapes (JSON drops an absent noul
        // `criteria`), so they go out as given.
        body: JSON.stringify({
          state: request.state,
          questions: request.questions,
          model: config.model,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        // Drain so the socket can be reused; discard it (never logged).
        await response.text().catch(() => undefined)
        throw new GatewayRequestError('decide', response.status)
      }
      // text() then parse, so a timeout mid-body surfaces as the abort it is
      // rather than being relabelled "not JSON".
      const body = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        throw new InvalidDecideError(`decide response body (length ${body.length}) is not JSON`)
      }
      return parseDecideResponse(request, payload)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    embed: (): Promise<EmbedResult> => notImplemented('embed'),
    complete: () => notImplemented('complete'),
    decide,
  }
}
