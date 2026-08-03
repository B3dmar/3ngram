// SPDX-License-Identifier: Apache-2.0
// REST /api/v1 mirror of the core memory tools (docs/concepts/architecture.mdx
// "one core, N transports"). A THIN adapter (transports hold zero
// business logic): each route validates at the ONE boundary (the SAME
// packages/schema Zod types the MCP tools consume — NO REST-only schemas),
// calls packages/core (which runs withTenant internally:
// a route can only ever touch the authenticated key owner's rows), and shapes
// the JSON mirror of the MCP tool IO.
//
// AUTH: mounted BEHIND the EXISTING apiKeyAuth middleware (X-API-Key) — NOT
// the Bearer/OAuth mount that gates /mcp. apiKeyAuth binds req.userId; a valid
// key is FULL-ACCESS (rest/scope.ts: the api_keys table has no scope column, so
// per-route OAuth scope is N/A for v1 keys). The router applies apiKeyAuth to
// every /api/v1 path itself, so it is mountable independent of the MCP mount.
//
// ERRORS: typed core errors map to HTTP status via rest/errors.ts (the MCP
// reason_code TAXONOMY mapped to HTTP, not the MCP isError function). An unknown
// error is a generic 500 (crash-safe, no content leaked).
//
// PARITY: this ships a SMOKE-level parity guarantee (REST remember -> the
// same content found via core search); FULL REST≡MCP≡core parity comes later.
import { log } from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import {
  type AccessGate,
  applyProposal,
  archiveMemory,
  type BudgetEnforcement,
  briefing,
  deleteAccount,
  describeEnvironment,
  type ExportEnricher,
  exportUserData,
  getBudgetStatus,
  getCurrentUser,
  getFacts,
  getMemoryById,
  getMemoryHistory,
  type LimitsResolver,
  listMemories,
  listMemoryFacets,
  listProposals,
  listScopes,
  rejectProposal,
  remember,
  resolveByMemoryId,
  revise,
  search,
  searchDashboardPage,
} from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import {
  type AsOfInput,
  accountDeleteBodySchema,
  briefingToolInputSchema,
  dashboardSearchQuerySchema,
  factsQueryInputSchema,
  memoriesListQuerySchema,
  proposalRejectBodySchema,
  proposalsListQuerySchema,
  rememberToolInputSchema,
  resolveToolInputSchema,
  reviseToolInputSchema,
  searchQuerySchema,
} from '@3ngram/schema'
import { type Request, type Response, Router } from 'express'
import { z } from 'zod'
import { apiOrSessionAuth } from '../middleware/api-or-session.js'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { mapRestError } from './errors.js'

// A non-UUID :id path segment can never match a stored uuid column, so treat a
// malformed id the same as an unknown id (404) instead of letting Postgres raise
// a uuid cast error that guard()'s catch surfaces as a generic 500 (mirrors the
// apiKeyIdSchema boundary in routes/api-keys.ts).
const pathIdSchema = z.uuid()

/** Options the boot wiring injects: the embedding gateway (undefined when not configured). */
export interface RestRouterOptions {
  /** Embedding gateway threaded through createApp (same seam mcpRouter gets) — undefined when env-gated off. */
  gateway: Gateway | undefined
  /** Per-API-key rate limiter for /api/v1. Mounted BEFORE apiOrSessionAuth. Session Bearer requests (no X-API-Key) skip it. */
  rateLimiter?: RateLimiterMiddleware
  /** Budget enforcement — gates every metered embed on /api/v1.
   * Threaded into remember/revise/import (pre-persist) and search (query embed).
   * Undefined → no budget gate (test/back-compat). */
  budget?: BudgetEnforcement | undefined
  /** Access gate — asserts read/write access on every /api/v1 route.
   * Undefined → no access guard (test/back-compat). */
  access?: AccessGate | undefined
  /** Billing-neutral resource-limit resolver. Omitted fields are unlimited. */
  limits?: LimitsResolver | undefined
  /** Account-deletion cleanup hook. The private repo injects platform-specific
   * cleanup; undefined → self-host runs no extra work. Apache code never imports
   * the private repo. */
  onAccountDeletion?: ((userId: string) => Promise<void>) | undefined
  /** GDPR-export enricher. The private repo adds extra user-owned rows to the
   * archive; undefined → self-host omits them. */
  exportEnricher?: ExportEnricher | undefined
}

/** Coerce an optional ISO-8601 string to a Date for the bi-temporal core query. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value)
}

/** Drop keys whose value is undefined so an exactOptional core param type fits. */
function defined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

/** Map a schema asOf (ISO strings) to the core/db Date coordinates, or undefined. */
function toAsOf(asOf: AsOfInput | undefined): { validAt?: Date; asKnownAt?: Date } | undefined {
  if (asOf === undefined) return undefined
  return defined({ validAt: toDate(asOf.validAt), asKnownAt: toDate(asOf.asKnownAt) })
}

function historyIdentity(memory: {
  id: string
  memoryType: string
  topic: string
  project: string | null
  scope: string
  status: string
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
  createdAt: Date
  isCurrent: boolean
  lifecycleState: string
}) {
  return {
    id: memory.id,
    memoryType: memory.memoryType,
    topic: memory.topic,
    project: memory.project ?? null,
    scope: memory.scope,
    status: memory.status,
    validFrom: memory.validFrom.toISOString(),
    validTo: memory.validTo?.toISOString() ?? null,
    recordedAt: memory.recordedAt.toISOString(),
    createdAt: memory.createdAt.toISOString(),
    isCurrent: memory.isCurrent,
    lifecycleState: memory.lifecycleState,
  }
}

function historyEdge(edge: {
  id: string
  fromId: string
  toId: string
  edgeType: string
  createdBy: string
  createdAt: Date
}) {
  return {
    id: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    edgeType: edge.edgeType,
    createdBy: edge.createdBy,
    createdAt: edge.createdAt.toISOString(),
  }
}

function historyRelationship(relationship: {
  memory: Parameters<typeof historyIdentity>[0]
  edge: Parameters<typeof historyEdge>[0]
}) {
  return {
    memory: historyIdentity(relationship.memory),
    edge: historyEdge(relationship.edge),
  }
}

/** The authenticated tenant — apiKeyAuth has bound req.userId before any handler runs. */
function tenant(req: Request): string {
  return req.userId as string
}

/**
 * Run a route handler with uniform typed-error -> HTTP mapping. A KNOWN typed
 * core error becomes its mapped status + reason_code body (rest/errors.ts); an
 * UNKNOWN error is logged crash-safe (no content) and surfaced as a
 * generic 500. Handlers never log content themselves.
 */
async function guard(route: string, res: Response, handler: () => Promise<void>): Promise<void> {
  try {
    await handler()
  } catch (err) {
    const mapped = mapRestError(route, err)
    if (mapped !== undefined) {
      res.status(mapped.status).json({ error: mapped.reason })
      return
    }
    log().error({ route, ...crashSafeError(err) }, 'rest: handler failed')
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
  }
}

/**
 * Build the /api/v1 REST router. Every route is guarded by apiOrSessionAuth
 * (applied at the router level), so the whole mirror is reachable with EITHER a
 * valid X-API-Key (C3) OR a session Bearer token (C2, from POST /auth/login) —
 * both bind req.userId identically. The mount stays independent of the MCP Bearer
 * (OAuth) mount.
 */
export function restRouter(options: RestRouterOptions): Router {
  const router = Router()
  // Per-key rate-limiter: mounted BEFORE apiOrSessionAuth so the bucket
  // is the cheapest first gate. Requests without req.apiKeyId (session Bearer)
  // skip it transparently (undefined key -> pass through).
  if (options.rateLimiter !== undefined) {
    router.use('/api/v1', options.rateLimiter)
  }
  // Combined auth on EVERY /api/v1 path: X-API-Key OR session
  // Bearer. Mounted here (not in app.ts) so the router is self-contained and
  // mountable independent of the MCP Bearer mount.
  router.use('/api/v1', apiOrSessionAuth)

  // POST /api/v1/memories — remember (mirrors the MCP remember tool). Core
  // remember() is THE validation boundary; we re-parse here only to echo the
  // NORMALIZED write (scope default + null project) in the response, exactly as
  // the MCP tool does. Embedding is ack-before-embed: never awaited.
  router.post('/api/v1/memories', (req, res) => {
    void guard('memories', res, async () => {
      const input = rememberToolInputSchema.parse(req.body)
      // Budget is wired alongside the gateway: it gates the embed this write will
      // kick, so it applies only when there is an embed to incur cost. The access
      // gate is threaded independently (even on the embeddings-off path) so the
      // write access guard runs on every write (no bypass).
      const gatewayOpts =
        options.gateway === undefined
          ? { access: options.access, limits: options.limits }
          : {
              gateway: options.gateway,
              budget: options.budget,
              access: options.access,
              limits: options.limits,
            }
      const written = await remember(tenant(req), input, 'user_api', gatewayOpts)
      void written.embed.settled.catch(() => false)
      const embedded = options.gateway === undefined ? 'off' : 'pending'
      res.status(201).json(
        defined({
          memory: {
            id: written.id,
            memoryType: input.memoryType,
            topic: input.topic,
            scope: input.scope,
            project: input.project ?? null,
          },
          embedded,
          commitmentId: written.commitmentId,
        }),
      )
    })
  })

  // GET /api/v1/memories — bounded LIVE-memory list for the dashboard.
  // Query params (limit/offset/type/scope/project/status, plus the V2 filters
  // memoryTypes/recordedAfter/recordedBefore — issue #48) arrive as
  // strings over a GET; the numeric ones are coerced BEFORE the single parse
  // against memoriesListQuerySchema. Core listMemories runs the
  // page + its unpaged total in one withTenant tx; the route shapes the
  // identity-only envelope (NO content).
  // `project` may appear once (string) or repeated (?project=a&project=b → string[])
  // — the schema accepts both; the db layer uses eq/inArray accordingly.
  router.get('/api/v1/memories', (req, res) => {
    void guard('memories.list', res, async () => {
      const query = memoriesListQuerySchema.parse(
        defined({
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
          type: req.query.type,
          scope: req.query.scope,
          project: req.query.project,
          status: req.query.status,
          // Filters V2 (issue #48): memoryTypes repeats like project (string
          // once, string[] repeated); the range bounds arrive as ISO strings.
          memoryTypes: req.query.memoryTypes,
          recordedAfter: req.query.recordedAfter,
          recordedBefore: req.query.recordedBefore,
        }),
      )
      // ACCESS GUARD: read access is asserted BEFORE the db op runs (self-host
      // allowAllAccess allows all; back-compat null-guard when no gate is wired).
      if (options.access) await options.access.assertRead(tenant(req))
      // The schema names the filter `type`; the core/db query names it
      // `memoryType` (the column). Bridge here so the wire stays dashboard-facing.
      // limit/offset carry schema defaults (always present); the OPTIONAL filters
      // are stripped of undefined keys so the exactOptional db query type fits.
      const page = await listMemories(tenant(req), {
        limit: query.limit,
        offset: query.offset,
        ...defined({
          memoryType: query.type,
          memoryTypes: query.memoryTypes,
          scope: query.scope,
          project: query.project,
          status: query.status,
          // ISO -> Date at the transport boundary (the same coercion the MCP
          // search tool applies to its recorded_at range bounds).
          recordedAfter:
            query.recordedAfter === undefined ? undefined : new Date(query.recordedAfter),
          recordedBefore:
            query.recordedBefore === undefined ? undefined : new Date(query.recordedBefore),
        }),
      })
      res.status(200).json({
        memories: page.memories.map((memory) => ({
          id: memory.id,
          memoryType: memory.memoryType,
          topic: memory.topic,
          project: memory.project ?? null,
          scope: memory.scope,
          status: memory.status,
          ...(memory.commitmentStatus === undefined || memory.commitmentStatus === null
            ? {}
            : { commitmentStatus: memory.commitmentStatus }),
          recordedAt: memory.recordedAt.toISOString(),
          createdAt: memory.createdAt.toISOString(),
        })),
        count: page.memories.length,
        total: page.total,
      })
    })
  })

  // GET /api/v1/memories/facets — DISTINCT scope + project values from the
  // tenant's LIVE memories. Registered BEFORE /:id so Express
  // does not match "facets" as an :id param. Returns {scopes, projects} arrays
  // ordered ASC. Content discipline: only user-defined labels.
  router.get('/api/v1/memories/facets', (req, res) => {
    void guard('memories.facets', res, async () => {
      // ACCESS GUARD: facets expose the tenant's scope/project labels
      // (memory-derived), so read access is asserted BEFORE the read (self-host
      // allowAllAccess allows all).
      if (options.access) await options.access.assertRead(tenant(req))
      const facets = await listMemoryFacets(tenant(req))
      res.status(200).json({ scopes: facets.scopes, projects: facets.projects })
    })
  })

  // GET /api/v1/scopes — list the tenant's registered scopes.
  router.get('/api/v1/scopes', (req, res) => {
    void guard('scopes.list', res, async () => {
      // ACCESS GUARD: the scope registry is per-tenant user data, so read access
      // is asserted BEFORE the read (self-host allowAllAccess allows all); parity
      // with the MCP configure_scope list action.
      if (options.access) await options.access.assertRead(tenant(req))
      const scopes = await listScopes(tenant(req))
      res.status(200).json({
        scopes: scopes.map((s) => ({
          id: s.id,
          name: s.name,
          aliases: s.aliases,
          createdAt: s.createdAt.toISOString(),
        })),
        count: scopes.length,
      })
    })
  })

  // GET /api/v1/memories/:id/history — identity-only lineage + audit trail for
  // dashboard detail. Registered before /:id for route clarity. Returns no
  // content and no raw audit payload values: only identity fields, typed edges,
  // event kind/actor/time, and payload metadata.
  router.get('/api/v1/memories/:id/history', (req, res) => {
    void guard('memories.history', res, async () => {
      const id = pathIdSchema.safeParse(req.params.id)
      if (!id.success) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // ACCESS GUARD: history exposes lineage + audit, so read access is asserted
      // BEFORE the read (self-host allowAllAccess allows all); matches the inspect
      // (getMemoryById) guard.
      if (options.access) await options.access.assertRead(tenant(req))
      const history = await getMemoryHistory(tenant(req), id.data)
      // Partial-failure degrades to 200 with `sections` flags. Emit a
      // content-free signal (id + status + error class name only)
      // when a section is unavailable so ops can see degradation without a 500.
      if (history.sections.lineage === 'unavailable' || history.sections.events === 'unavailable') {
        log().warn(
          {
            route: 'memories.history',
            memoryId: id.data,
            sections: history.sections,
            sectionErrors: history.sectionErrors ?? {},
          },
          'rest: memory history degraded',
        )
      }
      res.status(200).json({
        memory: historyIdentity(history.memory),
        lineage: {
          nodes: history.lineage.nodes.map(historyIdentity),
          edges: history.lineage.edges.map(historyEdge),
          truncated: history.lineage.truncated,
        },
        directRelationships: {
          predecessors: history.directRelationships.predecessors.map(historyRelationship),
          successors: history.directRelationships.successors.map(historyRelationship),
          truncated: history.directRelationships.truncated,
        },
        auditEvents: history.auditEvents.map((event) => ({
          id: event.id,
          eventKind: event.eventKind,
          actorKind: event.actorKind,
          createdAt: event.createdAt.toISOString(),
          payloadMetadata: event.payloadMetadata,
        })),
        eventsTruncated: history.eventsTruncated,
        sections: history.sections,
      })
    })
  })

  // GET /api/v1/memories/:id — inspect a single memory. Core
  // getMemoryById throws MemoryNotFoundError for an absent/cross-tenant id, which
  // the mapper turns into a 404. Returns the full row INCLUDING content (inspect
  // is its JTBD) — the content is never logged.
  router.get('/api/v1/memories/:id', (req, res) => {
    void guard('memories.inspect', res, async () => {
      const id = pathIdSchema.safeParse(req.params.id)
      if (!id.success) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // ACCESS GUARD: read access is asserted BEFORE the row is read (self-host
      // allowAllAccess allows all).
      if (options.access) await options.access.assertRead(tenant(req))
      const memory = await getMemoryById(tenant(req), id.data)
      res.status(200).json({
        id: memory.id,
        memoryType: memory.memoryType,
        topic: memory.topic,
        content: memory.content,
        scope: memory.scope,
        project: memory.project ?? null,
        status: memory.status,
        ...(memory.commitmentStatus === undefined || memory.commitmentStatus === null
          ? {}
          : { commitmentStatus: memory.commitmentStatus }),
        tags: memory.tags,
        validFrom: memory.validFrom.toISOString(),
        validTo: memory.validTo?.toISOString() ?? null,
        recordedAt: memory.recordedAt.toISOString(),
        createdAt: memory.createdAt.toISOString(),
      })
    })
  })

  // POST /api/v1/search - public REST mirror of the MCP search tool.
  router.post('/api/v1/search', (req, res) => {
    void guard('search', res, async () => {
      if (options.gateway === undefined) {
        res.status(503).json({ error: 'embedding_unavailable' })
        return
      }
      const input = searchQuerySchema.parse(req.body)
      const filters = defined({
        memoryType: input.memoryType,
        scope: input.scope,
        project: input.project,
        status: input.status,
        asOf: toAsOf(input.asOf),
      })
      const hits = await search(
        tenant(req),
        input.query,
        { gateway: options.gateway },
        { limit: input.limit, filters, budget: options.budget },
      )

      res.status(200).json({
        hits: hits.map((hit) => ({
          id: hit.id,
          memoryType: hit.memoryType,
          topic: hit.topic,
          content: hit.content,
          contentLength: hit.contentLength,
          truncated: hit.truncated,
          score: hit.score,
        })),
        count: hits.length,
      })
    })
  })

  // POST /api/v1/dashboard/search - dashboard continuation contract. This route
  // intentionally does not replace /api/v1/search, which is the SDK/CLI/MCP
  // mirror and must keep returning content excerpts.
  router.post('/api/v1/dashboard/search', (req, res) => {
    void guard('dashboard.search', res, async () => {
      if (options.gateway === undefined) {
        res.status(503).json({ error: 'embedding_unavailable' })
        return
      }
      const input = dashboardSearchQuerySchema.parse(req.body)
      const filters = defined({
        memoryType: input.memoryType,
        scope: input.scope,
        project: input.project,
        status: input.status,
        asOf: toAsOf(input.asOf),
      })
      // Frozen-ordering cursor: the first page ranks the bounded
      // candidate pool once and freezes the ordering into the cursor; a
      // continuation pages by position within it, so mid-session corpus drift
      // cannot duplicate or skip a row. A malformed cursor throws a ZodError
      // here -> 400 (mapRestError); a stale v1 cursor decodes to undefined and
      // restarts at page 1.
      const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor)
      const frozen =
        decoded === undefined
          ? undefined
          : { ids: decoded.ids, scores: decoded.scores, off: decoded.off }
      const page = await searchDashboardPage(
        tenant(req),
        input.query,
        { gateway: options.gateway },
        defined({ limit: input.limit, filters, frozen, budget: options.budget }),
      )
      // Only emit a cursor when there is a further page, so the client stops at
      // the window edge. The cursor carries the frozen ordering + next offset.
      const nextCursor = page.hasMore
        ? encodeCursor({
            v: 2,
            ids: page.frozen.ids,
            scores: page.frozen.scores,
            off: page.nextOffset,
          })
        : undefined

      res.status(200).json(
        defined({
          hits: page.hits.map((hit) =>
            defined({
              id: hit.id,
              memoryType: hit.memoryType,
              topic: hit.topic,
              score: hit.score,
              commitmentStatus: hit.commitmentStatus,
            }),
          ),
          count: page.hits.length,
          hasMore: page.hasMore,
          nextCursor,
        }),
      )
    })
  })

  // GET /api/v1/facts — get_facts (mirrors the MCP get_facts tool). Filters arrive
  // as query params; factsQueryInputSchema is the boundary. The MCP tool takes the
  // bi-temporal `asOf` coordinate in the body; over a GET querystring we accept it
  // as TWO FLAT keys — `validAt` and `asKnownAt` (ISO-8601 datetime strings) — and
  // reshape them into the nested `{asOf:{validAt?,asKnownAt?}}` object BEFORE the
  // single parse. The SAME factsQueryInputSchema validates it, so asOfSchema's
  // refine still rejects a bare `?asOf` with neither coordinate as a 400 (no silent
  // drop). `asOf` is omitted entirely when neither key is present (current-facts
  // default). ISO strings are coerced to Date at the core boundary via toAsOf,
  // exactly as the MCP get_facts handler bridges (apps/server/src/mcp/tools.ts).
  router.get('/api/v1/facts', (req, res) => {
    void guard('facts', res, async () => {
      const asOf =
        req.query.validAt === undefined && req.query.asKnownAt === undefined
          ? undefined
          : defined({ validAt: req.query.validAt, asKnownAt: req.query.asKnownAt })
      const input = factsQueryInputSchema.parse(
        defined({
          subject: req.query.subject,
          predicate: req.query.predicate,
          asOf,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        }),
      )
      // ACCESS GUARD: read access is asserted BEFORE facts are read (self-host
      // allowAllAccess allows all).
      if (options.access) await options.access.assertRead(tenant(req))
      const facts = await getFacts(
        tenant(req),
        defined({
          subject: input.subject,
          predicate: input.predicate,
          asOf: toAsOf(input.asOf),
          limit: input.limit,
        }),
      )
      res.status(200).json({
        facts: facts.map((fact) => ({
          id: fact.id,
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          confidence: fact.confidence,
          validFrom: fact.validFrom.toISOString(),
          validTo: fact.validTo?.toISOString() ?? null,
        })),
        count: facts.length,
      })
    })
  })

  // GET /api/v1/briefing — mirrors the MCP briefing tool. Flat query params
  // (kind/scope/project/mode) are reshaped into the nested selector BEFORE the
  // single briefingToolInputSchema parse. `now` is stamped here.
  router.get('/api/v1/briefing', (req, res) => {
    void guard('briefing', res, async () => {
      const input = briefingToolInputSchema.parse(
        defined({
          selector: defined({
            kind: req.query.kind,
            scope: req.query.scope,
            project: req.query.project,
          }),
          mode: req.query.mode,
        }),
      )
      // ACCESS GUARD: the briefing is memory-derived, so read access is asserted
      // BEFORE the read (self-host allowAllAccess allows all); parity with the MCP
      // briefing tool.
      if (options.access) await options.access.assertRead(tenant(req))
      const result = await briefing(tenant(req), {
        selector: input.selector,
        mode: input.mode,
        now: new Date(),
      })
      res.status(200).json(result)
    })
  })

  // POST /api/v1/memories/:id/revise — revise (mirrors the MCP revise tool). The
  // body is the full successor write; core revise() is THE validation boundary.
  // :id is the predecessor — merged into the body as predecessorId BEFORE the
  // single parse, so the URL and body cannot disagree (the URL wins).
  router.post('/api/v1/memories/:id/revise', (req, res) => {
    void guard('revise', res, async () => {
      const merged = { ...(req.body as Record<string, unknown>), predecessorId: req.params.id }
      const input = reviseToolInputSchema.parse(merged)
      const gatewayOpts =
        options.gateway === undefined
          ? { access: options.access, limits: options.limits }
          : {
              gateway: options.gateway,
              budget: options.budget,
              access: options.access,
              limits: options.limits,
            }
      const written = await revise(tenant(req), input, 'user_api', gatewayOpts)
      void written.embed.settled.catch(() => false)
      const embedded = options.gateway === undefined ? 'off' : 'pending'
      res.status(200).json({
        memory: {
          id: written.id,
          memoryType: input.memoryType,
          topic: input.topic,
          scope: input.scope,
          project: input.project ?? null,
        },
        embedded,
      })
    })
  })

  // POST /api/v1/memories/:id/resolve — resolve (mirrors the MCP resolve tool,
  // keyed on the MEMORY id from D1). :id -> memoryId merged with body -> status,
  // THEN validated against resolveToolInputSchema (single boundary). Serves
  // resolve AND unresolve (resolved -> open) — the FSM owns legality.
  router.post('/api/v1/memories/:id/resolve', (req, res) => {
    void guard('resolve', res, async () => {
      const merged = { ...(req.body as Record<string, unknown>), memoryId: req.params.id }
      const input = resolveToolInputSchema.parse(merged)
      // ACCESS GUARD: write access is asserted BEFORE the db op runs (self-host
      // allowAllAccess allows all).
      if (options.access) await options.access.assertWrite(tenant(req))
      const result = await resolveByMemoryId(tenant(req), input.memoryId, input.status, 'user_api')
      res.status(200).json({ commitmentId: result.id, status: result.status })
    })
  })

  // POST /api/v1/memories/:id/archive — archive an active memory of ANY type
  // (adoption-gate Decision D: REST-only, no MCP tool mirrors it). status flips
  // 'active' -> 'archived'; valid_to stays NULL, so the row lands in the archived
  // bucket GET /memories?status=archived and GET /stats read. No body: the :id
  // path segment is the whole input, bounded here (a malformed uuid can never
  // match a stored uuid, so it is the same 404 as an unknown id — mirrors the
  // proposals/:id routes). Core throws MemoryNotFoundError for an absent,
  // cross-tenant, already-archived, or superseded id — the mapper's 404.
  router.post('/api/v1/memories/:id/archive', (req, res) => {
    void guard('archive', res, async () => {
      const id = pathIdSchema.safeParse(req.params.id)
      if (!id.success) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // ACCESS GUARD: write access is asserted BEFORE the db op runs (self-host
      // allowAllAccess allows all).
      if (options.access) await options.access.assertWrite(tenant(req))
      const archived = await archiveMemory(tenant(req), id.data, 'user_api')
      res.status(200).json({ id: archived.id, status: archived.status })
    })
  })

  // GET /api/v1/proposals — bounded consolidation-proposal list over
  // the EXISTING core listProposals. status/limit arrive as query params; limit is
  // coerced before the single parse against proposalsListQuerySchema. The route
  // shapes the proposal records (timestamps to ISO; rationale may be null).
  router.get('/api/v1/proposals', (req, res) => {
    void guard('proposals.list', res, async () => {
      const query = proposalsListQuerySchema.parse(
        defined({
          status: req.query.status,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        }),
      )
      // ACCESS GUARD: proposals are memory-derived (consolidation candidates over
      // the tenant's memories), so read access is asserted BEFORE the read
      // (self-host allowAllAccess allows all).
      if (options.access) await options.access.assertRead(tenant(req))
      // limit carries the schema default (always present); status is OPTIONAL —
      // strip it when undefined so the exactOptional core query type fits.
      const proposals = await listProposals(tenant(req), {
        limit: query.limit,
        ...defined({ status: query.status }),
      })
      res.status(200).json({
        proposals: proposals.map((proposal) => ({
          id: proposal.id,
          fromId: proposal.fromId,
          toId: proposal.toId,
          edgeType: proposal.edgeType,
          memoryType: proposal.memoryType,
          similarity: proposal.similarity,
          rationale: proposal.rationale,
          status: proposal.status,
          decidedAt: proposal.decidedAt?.toISOString() ?? null,
          createdAt: proposal.createdAt.toISOString(),
        })),
        count: proposals.length,
      })
    })
  })

  // POST /api/v1/proposals/:id/apply — accept a proposal over the
  // EXISTING core applyProposal. A dashboard apply is attributed to the user_api
  // actor (the human reviewer acting through the UI). A missing/decided proposal
  // -> ProposalNotFoundError -> 404; a stale-successor apply -> 409 (the mapper).
  router.post('/api/v1/proposals/:id/apply', (req, res) => {
    void guard('proposals.apply', res, async () => {
      const id = pathIdSchema.safeParse(req.params.id)
      if (!id.success) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // ACCESS GUARD: applying a proposal mutates the graph — write access is
      // asserted BEFORE the db op (self-host allowAllAccess allows all).
      if (options.access) await options.access.assertWrite(tenant(req))
      const applied = await applyProposal(tenant(req), id.data, 'user_api')
      res.status(200).json({ id: applied.id, status: applied.status })
    })
  })

  // POST /api/v1/proposals/:id/reject — reject a proposal. The
  // optional {rationale} body is validated but not yet stored —
  // interim contract until a reviewer-rationale column lands.
  router.post('/api/v1/proposals/:id/reject', (req, res) => {
    void guard('proposals.reject', res, async () => {
      const id = pathIdSchema.safeParse(req.params.id)
      if (!id.success) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      // Parse (and thereby validate) the optional body even though core does not
      // consume the rationale yet — a malformed body is a 400 at the boundary,
      // never a silent accept.
      proposalRejectBodySchema.parse(req.body ?? {})
      // ACCESS GUARD: rejecting a proposal mutates its state — write access is
      // asserted BEFORE the db op (self-host allowAllAccess allows all).
      if (options.access) await options.access.assertWrite(tenant(req))
      const rejected = await rejectProposal(tenant(req), id.data)
      res.status(200).json({ id: rejected.id, status: rejected.status })
    })
  })

  // GET /api/v1/stats — the bounded environment COUNT aggregates via
  // the EXISTING core describeEnvironment (which wraps getEnvironmentStats). Only
  // the stats half is surfaced — counts only, NEVER content/values.
  router.get('/api/v1/stats', (req, res) => {
    void guard('stats', res, async () => {
      // ACCESS GUARD: stats are per-tenant memory-derived counts, so read access
      // is asserted BEFORE the read (self-host allowAllAccess allows all); parity
      // with MCP describe_environment.
      if (options.access) await options.access.assertRead(tenant(req))
      const report = await describeEnvironment(tenant(req))
      res.status(200).json(report.stats)
    })
  })

  // GET /api/v1/me — the authenticated identity. Works under BOTH
  // auth paths (X-API-Key and session Bearer both bind req.userId). Returns
  // {id,email}; the email is never logged.
  // DELIBERATELY UNGATED: returns ACCOUNT identity (id + email), not memory
  // or memory-derived data. A denied user must still reach their own account to
  // manage it — gating identity would lock them out of self-service. Not a
  // tenant-memory surface, so no gate applies.
  router.get('/api/v1/me', (req, res) => {
    void guard('me', res, async () => {
      const user = await getCurrentUser(tenant(req))
      res.status(200).json({ id: user.id, email: user.email })
    })
  })

  // GET /api/v1/budget — the caller's current budget status (effective cap +
  // consumed this cycle). Read-only. NOTE: the operator WRITE
  // (PUT cap_usd_override) is intentionally NOT exposed here: effectiveCap =
  // override ?? tierCap, so a self-service override would let a user nullify
  // their own cost cap. The override is operator-managed (admin-write only;
  // app_user has no UPDATE on plan_tiers and the override write awaits a distinct
  // admin-auth surface). 503 when budget enforcement is not wired (mirrors the
  // search embedding-unavailable contract).
  // DELIBERATELY UNGATED: returns cost status (cap + consumption), not memory or
  // memory-derived data. A denied user must keep reading their own budget status —
  // it is the very surface that explains a denial; gating it would be
  // self-defeating.
  router.get('/api/v1/budget', (req, res) => {
    void guard('budget', res, async () => {
      if (options.budget === undefined) {
        res.status(503).json({ error: 'budget_unavailable' })
        return
      }
      const status = await getBudgetStatus(options.budget, tenant(req))
      res.status(200).json({
        effectiveCapUsd: status.effectiveCapUsd,
        consumedUsd: status.consumedUsd,
        capUsdOverride: status.capUsdOverride,
        periodStart: status.periodStart?.toISOString() ?? null,
        periodEnd: status.periodEnd?.toISOString() ?? null,
      })
    })
  })

  // GET /api/v1/export — GDPR Art. 20 data portability. A
  // self-serve, machine-readable download of the caller's COMPLETE dataset:
  // account identity (never the password hash) + every memory/fact/commitment/
  // scope/edge/memory-event/proposal they own (the full set of tenant PII,
  // plus the typed memory graph), across all lifecycle states
  // (docs/concepts/memory-model.mdx retains superseded rows —
  // the export includes them). Core exportUserData runs withTenant at REPEATABLE
  // READ, so the whole archive is one consistent snapshot and a route can only ever
  // return the authenticated owner's rows; the content it returns is
  // the JTBD and is NEVER logged.
  // ACCESS GUARD: the export is a memory-derived read, so read access is asserted
  // BEFORE the read (self-host allowAllAccess allows all), matching every other
  // read route's idiom.
  // Content-Disposition makes it a browser download with a dated filename.
  router.get('/api/v1/export', (req, res) => {
    void guard('export', res, async () => {
      if (options.access) await options.access.assertRead(tenant(req))
      const data = await exportUserData(tenant(req), options.exportEnricher)
      const stamp = new Date().toISOString().slice(0, 10)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="3ngram-export-${stamp}.json"`)
      res.status(200).json({
        format: '3ngram.account-export.v1',
        exportedAt: new Date().toISOString(),
        account: {
          id: data.account.id,
          email: data.account.email,
          emailVerifiedAt: data.account.emailVerifiedAt?.toISOString() ?? null,
          createdAt: data.account.createdAt.toISOString(),
          updatedAt: data.account.updatedAt.toISOString(),
        },
        memories: data.memories.map((memory) => ({
          id: memory.id,
          memoryType: memory.memoryType,
          topic: memory.topic,
          content: memory.content,
          scope: memory.scope,
          project: memory.project ?? null,
          status: memory.status,
          tags: memory.tags,
          validFrom: memory.validFrom.toISOString(),
          validTo: memory.validTo?.toISOString() ?? null,
          recordedAt: memory.recordedAt.toISOString(),
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        })),
        facts: data.facts.map((fact) => ({
          id: fact.id,
          memoryId: fact.memoryId,
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          confidence: fact.confidence,
          validFrom: fact.validFrom.toISOString(),
          validTo: fact.validTo?.toISOString() ?? null,
          recordedAt: fact.recordedAt.toISOString(),
          createdAt: fact.createdAt.toISOString(),
        })),
        commitments: data.commitments.map((commitment) => ({
          id: commitment.id,
          memoryId: commitment.memoryId,
          status: commitment.status,
          owner: commitment.owner ?? null,
          dueAt: commitment.dueAt?.toISOString() ?? null,
          recurrence: commitment.recurrence ?? null,
          nextSurfacingAt: commitment.nextSurfacingAt?.toISOString() ?? null,
          resolvedAt: commitment.resolvedAt?.toISOString() ?? null,
          createdAt: commitment.createdAt.toISOString(),
          updatedAt: commitment.updatedAt.toISOString(),
        })),
        scopes: data.scopes.map((scope) => ({
          id: scope.id,
          name: scope.name,
          aliases: scope.aliases,
          createdAt: scope.createdAt.toISOString(),
        })),
        edges: data.edges.map((edge) => ({
          id: edge.id,
          fromId: edge.fromId,
          toId: edge.toId,
          edgeType: edge.edgeType,
          createdBy: edge.createdBy,
          createdAt: edge.createdAt.toISOString(),
        })),
        memoryEvents: data.memoryEvents.map((event) => ({
          id: event.id,
          memoryId: event.memoryId,
          eventKind: event.eventKind,
          actorKind: event.actorKind,
          payload: event.payload ?? null,
          createdAt: event.createdAt.toISOString(),
        })),
        proposals: data.proposals.map((proposal) => ({
          id: proposal.id,
          fromId: proposal.fromId,
          toId: proposal.toId,
          edgeType: proposal.edgeType,
          memoryType: proposal.memoryType,
          similarity: proposal.similarity,
          rationale: proposal.rationale ?? null,
          status: proposal.status,
          decidedAt: proposal.decidedAt?.toISOString() ?? null,
          createdAt: proposal.createdAt.toISOString(),
        })),
        userBudgets: data.userBudgets.map((budget) => ({
          id: budget.id,
          capUsdOverride: budget.capUsdOverride ?? null,
          periodStart: budget.periodStart?.toISOString() ?? null,
          periodEnd: budget.periodEnd?.toISOString() ?? null,
          updatedAt: budget.updatedAt.toISOString(),
        })),
        llmUsage: data.llmUsage.map((usage) => ({
          id: usage.id,
          operation: usage.operation,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd ?? null,
          createdAt: usage.createdAt.toISOString(),
        })),
        profile: data.profile
          ? {
              role: data.profile.role,
              useCase: data.profile.useCase,
              aiTools: data.profile.aiTools,
              referralSource: data.profile.referralSource,
              createdAt: data.profile.createdAt.toISOString(),
              updatedAt: data.profile.updatedAt.toISOString(),
            }
          : null,
        counts: {
          memories: data.memories.length,
          facts: data.facts.length,
          commitments: data.commitments.length,
          scopes: data.scopes.length,
          edges: data.edges.length,
          memoryEvents: data.memoryEvents.length,
          proposals: data.proposals.length,
          userBudgets: data.userBudgets.length,
          llmUsage: data.llmUsage.length,
        },
      })
    })
  })

  // DELETE /api/v1/account — self-serve account deletion (GDPR Art. 17).
  // Requires an explicit { confirm: true } body (validated at the
  // ONE schema boundary). Core deleteAccount erases the caller's PII in place and
  // physically deletes NO memory-domain row (docs/concepts/memory-model.mdx; the runtime
  // grant forbids it), revokes every credential, runs the optional platform
  // cleanup hook (absent on self-host — no private import), and writes a
  // content-free audit tombstone. Idempotent.
  // DELIBERATELY UNGATED (mirrors /me, /budget): a denied user MUST be able to
  // exercise their erasure right — gating deletion behind access status would trap
  // them. Response carries counts only.
  router.delete('/api/v1/account', (req, res) => {
    void guard('account.delete', res, async () => {
      accountDeleteBodySchema.parse(req.body ?? {})
      const result = await deleteAccount(tenant(req), {
        now: new Date(),
        ...(options.onAccountDeletion !== undefined
          ? { onAccountDeletion: options.onAccountDeletion }
          : {}),
      })
      res.status(200).json({
        deleted: true,
        alreadyDeleted: result.alreadyDeleted,
        erased: {
          memories: result.erased.memories,
          facts: result.erased.facts,
          commitments: result.erased.commitments,
          proposals: result.erased.proposals,
          sessionsDeleted: result.erased.sessionsDeleted,
          apiKeysRevoked: result.erased.apiKeysRevoked,
          oauthTokensRevoked: result.erased.oauthTokensRevoked,
          oauthCodesDeleted: result.erased.oauthCodesDeleted,
          passwordResetTokensDeleted: result.erased.passwordResetTokensDeleted,
          emailVerificationTokensDeleted: result.erased.emailVerificationTokensDeleted,
        },
      })
    })
  })

  return router
}
