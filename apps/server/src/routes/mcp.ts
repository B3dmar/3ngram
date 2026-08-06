// SPDX-License-Identifier: Apache-2.0
// MCP dual-era Streamable HTTP handler at /mcp.
//
// STATELESS by design: createMcpHandler calls the factory for every request.
// Its default legacy:'stateless' path preserves 2025-era clients while its
// modern path serves 2026-07-28. No tenant/session state lives in process.
//
// AUTH: BEARER-ONLY (strict RS). The route mounts BEHIND the
// existing oauthBearerAuth middleware ONLY — NOT the apiKeyAuth chain — so
// an X-API-Key alone never reaches a tool; a 401 without a valid Bearer carries
// the RFC 9728 WWW-Authenticate challenge the discovery doc already advertises.
// oauthBearerAuth also attaches the SDK AuthInfo bridge consumed by the Node
// adapter. The tenant id stays in verified authInfo.extra; clientId remains the
// OAuth client identifier and is never treated as the tenant.
//
// LAYERING: zero business logic here — the route wires the SDK
// handler to the per-request server and threads the authenticated tenant +
// optional gateway into the tools. Observability: nothing logged
// here echoes request content.
import { log } from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import {
  type AccessGate,
  type BudgetEnforcement,
  type LimitsResolver,
  type RetrievalPolicy,
  resolveRetrievalPolicy,
} from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import { toNodeHandler } from '@modelcontextprotocol/node'
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server'
import { Router } from 'express'
import { createMcpServer } from '../mcp/server.js'
import { mcpOriginValidation } from '../middleware/mcp-origin.js'
import { oauthBearerAuth } from '../middleware/oauth-bearer.js'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'

/** Options the boot wiring injects: the embedding gateway, undefined when not configured. */
export interface McpRouterOptions {
  gateway: Gateway | undefined
  /**
   * Per-user rate limiter. Runs AFTER oauthBearerAuth so it keys on the
   * authenticated principal (req.userId). Injected by the app factory; tests drive
   * it with an in-memory limiter so NO real Redis is required in CI.
   */
  limiter: RateLimiterMiddleware
  /** Budget enforcement — gates metered MCP tools (remember/
   * revise/search). The second of the two enforcement points. */
  budget?: BudgetEnforcement | undefined
  /** Access gate — asserts read/write access on every MCP tool. */
  access?: AccessGate | undefined
  /** Billing-neutral resource-limit resolver. Omitted fields are unlimited. */
  limits?: LimitsResolver | undefined
}

type McpProtocolOptions = Omit<McpRouterOptions, 'limiter'>

/** Recover the tenant identity only from the verified SDK auth bridge. */
function requireUserId(ctx: McpRequestContext): string {
  const userId = ctx.authInfo?.extra?.userId
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('verified MCP auth context has no tenant id')
  }
  return userId
}

/**
 * Request-scoped retrieval-scope policy resolver (issue #47): a MEMOIZED
 * thunk over core resolveRetrievalPolicy, built once per request so the
 * policy is resolved AT MOST ONCE — and lazily, only when a policy-enforced
 * read tool actually runs (write tools never pay the lookup). Pure wiring:
 * the resolution semantics live in core (hard rule 5).
 */
function lazyRetrievalPolicy(userId: string): () => Promise<RetrievalPolicy> {
  let cached: Promise<RetrievalPolicy> | undefined
  return () => {
    cached ??= resolveRetrievalPolicy(userId)
    return cached
  }
}

/**
 * Build the web-standard dual-era handler. The default legacy mode is
 * deliberately explicit here: 2025-era stateless requests and modern
 * 2026-07-28 requests share this one factory and therefore cannot drift.
 */
export function createMcpProtocolHandler(options: McpProtocolOptions): McpHttpHandler {
  return createMcpHandler(
    (ctx) => {
      const userId = requireUserId(ctx)
      return createMcpServer({
        userId,
        scopes: ctx.authInfo?.scopes ?? [],
        gateway: options.gateway,
        budget: options.budget,
        access: options.access,
        limits: options.limits,
        // Once-per-request policy resolution (issue #47), lazily memoized.
        retrievalPolicy: lazyRetrievalPolicy(userId),
      })
    },
    {
      legacy: 'stateless',
      onerror: (err) => log().error(crashSafeError(err), 'mcp: protocol handler error'),
    },
  )
}

/**
 * Build the /mcp Express router. The Node adapter forwards req.auth and the
 * already-parsed JSON body into the dual-era handler. Tool authorization still
 * runs inside the registered handler from verified scopes; transport headers
 * are never an authorization source.
 */
export function mcpRouter(options: McpRouterOptions): Router {
  const router = Router()
  const handler = createMcpProtocolHandler({
    gateway: options.gateway,
    budget: options.budget,
    access: options.access,
    limits: options.limits,
  })
  const handle = toNodeHandler(handler, {
    onerror: (err) => log().error(crashSafeError(err), 'mcp: node adapter error'),
  })

  // Origin validation runs FIRST (spec MUST, DNS-rebinding defense): a foreign
  // browser origin is refused before authentication and before it can consume a
  // rate-limit point. It sits here rather than beside app.use('/mcp', ...) so
  // all /mcp route policy stays in one file; the tradeoff is that it runs AFTER
  // express.json(), so a rejected body was parsed first — acceptable, since the
  // per-IP edgeLimiter already bounds that upstream and nothing past the 403 runs.
  //
  // Bearer-only guard on every method (POST/GET/DELETE). The 401 challenge +
  // WWW-Authenticate is the RFC 9728 client bootstrap. The per-user limiter runs
  // AFTER auth so it keys on the verified req.userId (docs/concepts/mcp-design.mdx per-user
  // bucket); an unauthenticated request is rejected before it can consume a point.
  router.all('/mcp', mcpOriginValidation, oauthBearerAuth, options.limiter, (req, res) => {
    handle(req, res, req.body).catch((err: unknown) => {
      log().error(crashSafeError(err), 'mcp: unhandled handler rejection')
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  })

  return router
}
