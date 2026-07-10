// SPDX-License-Identifier: Apache-2.0
// REST scope model (docs/concepts/architecture.mdx thin transport).
//
// DECISION (validator-resolved): the REST `/api/v1` mirror is FULL-ACCESS per
// valid API key. Per-route OAuth-style scope (the MCP transport's read/write
// floor, inline in apps/server/src/mcp/tools.ts runTool) is N/A for v1 API keys.
//
// WHY: the `api_keys` table carries ONLY keyHash / prefix / revokedAt /
// lastUsedAt (packages/db) — there is NO scope column, so an API key grants no
// finer grain than "this is user X". The C3 apiKeyAuth middleware
// (apps/server/src/middleware/api-key.ts) resolves a presented key to its owner
// and binds req.userId; it surfaces no scope set. Unlike a Bearer token (whose
// verified `scope` claim oauthBearerAuth parses into req.oauthScopes, feeding the
// MCP per-tool floor), an API key authenticates a TENANT, not a capability
// subset. So there is no read/write split to mirror and no scope floor to
// enforce: a valid key reaches every route, every route runs withTenant under
// that key's owner, and RLS is the only authority boundary.
//
// This module is DELIBERATELY a no-op documentation seam (NOT imported from
// apps/server/src/mcp/ — the MCP floor is inline in runTool, not exported, and
// this track does not touch mcp/). It exists so a future API-key scope model
// (should the schema grow a scope column) has ONE place to reintroduce the floor
// without re-plumbing the router. {@link assertRouteScope} is the seam: today it
// always passes (full access); tomorrow it would gate on the key's granted
// scopes.
//
// The read/write CONSTANTS are re-declared here (string literals, not imported
// from @3ngram/core/auth) only to document the actions each route maps to — they
// are NOT enforced for v1 API keys. A scoped key would compare these against the
// key's granted set in {@link assertRouteScope}.

/** The read action a route performs (documentation only — not enforced for v1 API keys). */
export const REST_READ_ACTION = 'read' as const
/** The write action a route performs (documentation only — not enforced for v1 API keys). */
export const REST_WRITE_ACTION = 'write' as const

/** The action class a route maps to (its OAuth-scope equivalent, were keys scoped). */
export type RouteAction = typeof REST_READ_ACTION | typeof REST_WRITE_ACTION

/**
 * Assert the authenticated API key may perform `action` on a route. For v1 API
 * keys this is a NO-OP: keys are full-access (no scope column — see module note),
 * so every action is permitted. This is the single seam a scoped-key model would
 * fill: compare `action` against the key's granted scopes and return false to
 * yield a 403 insufficient_scope. Today it always returns true.
 */
export function assertRouteScope(_action: RouteAction): boolean {
  return true
}
