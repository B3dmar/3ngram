// SPDX-License-Identifier: Apache-2.0
// Composite gateway (issue #225): `embed`/`complete` go to the OpenAI-compatible
// gateway, `decide` goes to the judgment gateway when one is configured.
//
// The apps resolve both from env and compose them here, so every core call site
// keeps receiving ONE Gateway. With no judgment gateway, `decide` rejects with
// the base gateway's NotImplementedError: "not configured" is a typed rejection
// a caller can discriminate on, never a crash.
import type { Gateway } from './types.js'

export interface ComposeGatewayParts {
  /** Serves embed() and complete(). Absent = no LLM configured at all. */
  base: Gateway | undefined
  /** Serves decide(). Absent = typed judgments unavailable. */
  judgment?: Gateway | undefined
}

/**
 * Compose the deployment's gateway. Returns `undefined` when `base` is absent,
 * even if a judgment gateway is configured: every consumer reads an undefined
 * gateway as "no LLM" (search reports not-configured, remember skips
 * embedding), and a composite whose embed() threw would turn those degraded
 * paths into failures. Judgment therefore requires the base gateway too.
 */
export function composeGateway(parts: ComposeGatewayParts): Gateway | undefined {
  const { base, judgment } = parts
  if (base === undefined) return undefined
  if (judgment === undefined) return base
  return {
    embed: (texts, operation) => base.embed(texts, operation),
    complete: (prompt, operation, options) => base.complete(prompt, operation, options),
    decide: (request, operation) => judgment.decide(request, operation),
  }
}
