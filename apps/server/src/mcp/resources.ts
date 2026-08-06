// SPDX-License-Identifier: Apache-2.0
// MCP RESOURCES — `threengram://memory/{id}` (issue #105).
//
// Design and the reasoning behind every decision here: docs/concepts/mcp-resources.mdx.
// Read it before changing this file; the payload rule below is load-bearing, not
// a shape someone picked.
//
// WHY A RESOURCE AT ALL: `resources/read` is CACHEABLE on 2026-07-28. A client
// that pulled a `truncated: true` search hit can cache the full body instead of
// re-calling get_memories every session. Resources also cost nothing against the
// 12-tool cap (hard rule 8).
//
// ADDRESSING — the id, not a version. `revise` does not modify a memory: it
// closes the predecessor's validity and APPENDS a successor with a NEW id
// (packages/db/src/memory-revise.ts). A successor is a different memory, so this
// URI is already version-addressed by construction; there is no version column
// for a second path segment to name.
//
// LAYERING: zero business logic (hard rule 5). The read validates the id at the
// schema boundary, asserts scope + access, calls the COMPLETE core service
// (which runs withTenant internally), and projects the result.
import { log } from '@3ngram/config'
import { getMemoryById, MemoryNotFoundError } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ToolContext } from './tools.js'

/**
 * The URI template clients complete. One variable, `{id}`, a memory uuid.
 *
 * SCHEME IS `threengram`, NOT `3ngram`. RFC 3986 requires a scheme to begin with
 * a letter (`scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), so
 * `3ngram://…` is not a parseable URI at all — `new URL('3ngram://memory/x')`
 * throws. The SDK hands the read callback a real `URL`, so a digit-leading
 * scheme could never have worked; issue #105 and the first draft of
 * docs/concepts/mcp-resources.mdx both specified one. Do not "fix" this back.
 *
 * The `memory` authority segment leaves room for a future
 * `threengram://thread/{name}` without re-cutting the namespace.
 */
export const MEMORY_RESOURCE_TEMPLATE = 'threengram://memory/{id}'

/**
 * TTL for a memory body. DELIBERATELY ITS OWN CONSTANT, not a reuse of
 * MCP_CATALOG_CACHE_TTL_MS: the catalogs go stale on a deployment, a memory body
 * essentially never does, and sharing one number means whoever retunes
 * deployment freshness silently retunes memory caching too.
 *
 * 24 hours is long precisely because the projection below carries nothing that
 * can change (see MEMORY_RESOURCE_FIELDS). The bound on how long it can be is
 * the PII-erasure path, which rewrites content — that is closed by erasure
 * revoking every OAuth token in the same transaction, so a `private` entry
 * cannot be reused by a caller whose token no longer authenticates.
 */
export const MEMORY_RESOURCE_CACHE_TTL_MS = 24 * 60 * 60_000

/** Reject a non-uuid `{id}` before it reaches core (one validation boundary). */
const memoryIdSchema = z.uuid()

/**
 * The IMMUTABLE PROJECTION — the entire reason the TTL can be long.
 *
 * These are the columns no ordinary write path can change. Enumerating every
 * UPDATE against `memories` (revise, import, proposals-apply, embedding
 * backfill, account-delete) shows the rest is lifecycle state.
 *
 * `status`, `validTo`, `commitmentStatus`, and `tags` are OMITTED ON PURPOSE.
 * They are exactly what supersession, archiving, and `resolve` move. Adding any
 * of them turns a correct cache into one that serves wrong answers for up to a
 * day, and forces the TTL down to where this feature stops paying for itself.
 * A client that needs "is this still current" asks `get_memories` or `search` —
 * tool results are never cacheable, so they answer about right now.
 *
 * IF YOU ARE ABOUT TO ADD A FIELD HERE: check it against that list first, and
 * read docs/concepts/mcp-resources.mdx. Widening this projection is a design
 * change, not a tweak.
 */
const MEMORY_RESOURCE_FIELDS = [
  'id',
  'memoryType',
  'topic',
  'content',
  'contentLength',
  'scope',
  'project',
  'recordedAt',
] as const

/**
 * Register `threengram://memory/{id}`. registerResource AUTO-ENABLES the `resources`
 * capability, so resources/templates/list + resources/read are served with no
 * transport change — both stay Bearer-gated by routes/mcp.ts exactly like
 * tools/*, and the per-read scope gate below is the resource analogue of
 * runTool's.
 *
 * `list: undefined` is passed EXPLICITLY (the SDK requires the key so nobody
 * forgets it): enumerating a tenant's corpus is the firehose the no-firehose
 * rule exists to prevent, so `resources/list` returns nothing for this template.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'memory',
    new ResourceTemplate(MEMORY_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: 'Memory',
      description:
        'The stored body of one memory by id, addressed as threengram://memory/{id}. Carries only the fields that never change after write (content, topic, type, scope, project, recordedAt) so it can be cached; lifecycle state (status, validity, commitment status, tags) is deliberately absent — read search or get_memories for that.',
      mimeType: 'application/json',
      // cacheScope MUST be private: this is tenant data, and the spec is
      // explicit that a `public` result from an authenticated endpoint may be
      // served across authorization contexts. `public` here would be a
      // cross-tenant disclosure with a cache in front of it.
      cacheHint: { ttlMs: MEMORY_RESOURCE_CACHE_TTL_MS, cacheScope: 'private' },
    },
    async (uri: URL, variables) => {
      // SCOPE GATE (fail-closed), the resource analogue of runTool's. ctx.scopes
      // is empty when the token carried no `scope` claim, so a scopeless token
      // satisfies nothing and reads no memory.
      if (!ctx.scopes.includes(MEMORY_READ_SCOPE)) {
        throw new Error(`insufficient scope: ${MEMORY_READ_SCOPE} required`)
      }
      // `variables` is the SDK's own expansion of the URI template, so the id
      // never gets hand-parsed out of a path. The id is caller-supplied; the
      // TENANT never is — it comes from the closure over the verified authInfo
      // (routes/mcp.ts requireUserId), the same path every tool uses.
      const raw = variables.id
      const id = memoryIdSchema.safeParse(Array.isArray(raw) ? raw[0] : raw)
      // A malformed id is reported EXACTLY like a missing one: telling the
      // caller "that is not a uuid" versus "no such memory" is a distinction
      // only an oracle needs.
      if (!id.success) throw new MemoryNotFoundError(String(raw))
      // ACCESS GUARD: this exports memory content, so read access is asserted
      // BEFORE the db op — mirrors get_memories / handoff / get_facts.
      if (ctx.access) await ctx.access.assertRead(ctx.userId)
      // core getMemoryById runs withTenant (RLS) and throws MemoryNotFoundError
      // for an id that is unknown OR belongs to another tenant. That collapse is
      // the point: a cross-tenant id must be INDISTINGUISHABLE from a missing
      // one, or this URI becomes an existence oracle for other tenants' ids.
      const memory = await getMemoryById(ctx.userId, id.data)
      const body = {
        id: memory.id,
        memoryType: memory.memoryType,
        topic: memory.topic,
        content: memory.content,
        contentLength: memory.content.length,
        scope: memory.scope,
        project: memory.project,
        recordedAt: memory.recordedAt.toISOString(),
      }
      log().debug({ resource: 'memory' }, 'mcp: resource read')
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body),
          },
        ],
      }
    },
  )
}

/** The projection's field list, exported so a test can assert it never widens. */
export const MEMORY_RESOURCE_PROJECTION: readonly string[] = MEMORY_RESOURCE_FIELDS
