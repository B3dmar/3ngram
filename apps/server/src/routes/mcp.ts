// SPDX-License-Identifier: Apache-2.0
// MCP Streamable HTTP transport at /mcp.
//
// STATELESS by design: a fresh McpServer + StreamableHTTPServerTransport per
// request (sessionIdGenerator: undefined). No in-process session state — any
// instance serves any request (Railway redeploy = non-event).
//
// AUTH: BEARER-ONLY (strict RS). The route mounts BEHIND the
// existing oauthBearerAuth middleware ONLY — NOT the apiKeyAuth chain — so
// an X-API-Key alone never reaches a tool; a 401 without a valid Bearer carries
// the RFC 9728 WWW-Authenticate challenge the discovery doc already advertises.
// req.userId is the strict-aud-verified token subject by the time a handler runs.
//
// LAYERING: zero business logic here — the route wires the SDK
// transport to the per-request server and threads the authenticated tenant +
// optional gateway into the tools. Observability: nothing logged
// here echoes request content.
import { log } from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import type { AccessGate, BudgetEnforcement, LimitsResolver } from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type Request, type Response, Router } from 'express'
import { createMcpServer } from '../mcp/server.js'
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

/**
 * Build the /mcp router. Streamable HTTP handles POST (JSON-RPC), GET (SSE
 * stream) and DELETE (session close) on one path; in stateless mode each is
 * served by a per-request transport with no shared state. The SDK's
 * handleRequest writes the response; on an unexpected pre-response failure we
 * emit a generic 500 (no content) and never leak the error to the client.
 */
export function mcpRouter(options: McpRouterOptions): Router {
  const router = Router()

  const handle = async (req: Request, res: Response): Promise<void> => {
    // oauthBearerAuth guarantees req.userId + req.oauthScopes are bound before
    // this runs. Scopes thread into the per-request context so each tool enforces
    // its required scope; fail-closed when the claim was absent
    // (req.oauthScopes is then an empty array).
    const server = createMcpServer({
      userId: req.userId as string,
      scopes: req.oauthScopes ?? [],
      gateway: options.gateway,
      budget: options.budget,
      access: options.access,
      limits: options.limits,
    })
    // Stateless: OMIT sessionIdGenerator (optional) — its absence is what selects
    // stateless mode, so no in-process session map is ever created.
    const transport = new StreamableHTTPServerTransport({})
    // Stateless: tear the per-request server + transport down when the response
    // closes so nothing lingers in-process between requests.
    res.on('close', () => {
      transport.close().catch(() => undefined)
      server.close().catch(() => undefined)
    })
    try {
      // The SDK transport declares its optional callbacks as `T | undefined`,
      // which trips exactOptionalPropertyTypes against the Transport interface's
      // `?:` optionals; the shapes are otherwise identical (an SDK type quirk).
      await server.connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      log().error(crashSafeError(err), 'mcp: transport error')
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' })
      }
    }
  }

  // Bearer-only guard on every method (POST/GET/DELETE). The 401 challenge +
  // WWW-Authenticate is the RFC 9728 client bootstrap. The per-user limiter runs
  // AFTER auth so it keys on the verified req.userId (docs/concepts/mcp-design.mdx per-user
  // bucket); an unauthenticated request is rejected before it can consume a point.
  router.all('/mcp', oauthBearerAuth, options.limiter, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log().error(crashSafeError(err), 'mcp: unhandled handler rejection')
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  })

  return router
}
