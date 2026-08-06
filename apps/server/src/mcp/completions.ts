// SPDX-License-Identifier: Apache-2.0
// MCP COMPLETIONS — argument autocompletion over the tenant's own facets (issue #104).
//
// WHAT IT SOLVES: prompts and tools take scope/project labels, and a client had
// no way to offer the tenant's ACTUAL values, so users typed them from memory
// and a typo silently returned nothing.
//
// THIN ADAPTER (hard rule 5): core listMemoryFacets already returns the DISTINCT
// scope + project values for a tenant, already runs withTenant, and is already
// the source the REST facets route uses. This module adds the guards and the
// prefix filter; it owns no query.
//
// SECURITY — the spec's completion section calls out information disclosure by
// name, and facet labels ARE tenant data (the REST route guards them for exactly
// that reason). Three rules, all enforced below:
//   1. the tenant comes from the closure over verified authInfo, NEVER from the
//      completion request's arguments, which are attacker-controlled;
//   2. MEMORY_READ_SCOPE is required, fail-closed, like every read tool;
//   3. the access gate runs before the read, mirroring the REST facets route.
//
// RATE LIMITING: the spec expects servers to rate-limit completion specifically.
// A client may fire one request per keystroke, and each is a separate HTTP
// request, so per-request memoization buys nothing — the protection is the
// existing per-user limiter mounted ahead of the handler in routes/mcp.ts.
//
// NO CACHE HINTS: completion results are not a cacheable operation in this
// revision, and they are tenant-specific besides.
import { listMemoryFacets } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import type { ToolContext } from './tools.js'

/** Which facet a completer offers. */
type Facet = 'scopes' | 'projects'

/**
 * Case-insensitive prefix match on what the user has typed so far. The spec
 * passes the partial value; returning the unfiltered list would make the client
 * do the filtering and waste the round trip.
 *
 * The SDK caps the response at 100 values and sets `total`/`hasMore` itself
 * (createCompletionResult), so this returns everything that matches and lets
 * that boundary do the truncation — one place owns the cap.
 */
function matching(values: readonly string[], typed: string): string[] {
  if (typed === '') return [...values]
  const needle = typed.toLowerCase()
  return values.filter((value) => value.toLowerCase().startsWith(needle))
}

/**
 * Build a completer for one facet, bound to a request's tenant.
 *
 * Returns [] rather than throwing on a denied read: a completion is a UI
 * affordance, and a client that cannot complete should degrade to a plain text
 * field, not surface an error mid-keystroke. The important half is that it
 * returns NOTHING — the guards still hold, they just fail quiet.
 */
export function facetCompleter(
  ctx: ToolContext,
  facet: Facet,
): (value: string) => Promise<string[]> {
  return async (value: string) => {
    // SCOPE GATE (fail-closed). ctx.scopes is empty when the token carried no
    // `scope` claim, so a scopeless token completes nothing.
    if (!ctx.scopes.includes(MEMORY_READ_SCOPE)) return []
    // ACCESS GUARD before the read — scope/project labels are memory-derived
    // tenant data, which is why the REST facets route guards them too.
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    const facets = await listMemoryFacets(ctx.userId)
    return matching(facets[facet], value)
  }
}
