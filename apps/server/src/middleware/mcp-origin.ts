// SPDX-License-Identifier: Apache-2.0
// Origin validation for /mcp (MCP Streamable HTTP, revision 2026-07-28).
//
// THE SPEC RULE: "Servers MUST validate the Origin header on all incoming
// connections to prevent DNS rebinding attacks. If the Origin header is present
// and invalid, servers MUST respond with HTTP 403 Forbidden." Note the
// conditional — PRESENT and invalid. Absence is not a violation, which is what
// makes the allow-on-absent rule below spec-correct rather than a loophole:
// non-browser clients (Claude Desktop, the CLI, agent runtimes) send no Origin,
// and rejecting on absence would break every real client.
//
// WHY HAND-ROLLED: the SDK exports originValidationResponse, but it operates on
// a web Request and this deployment reaches the handler through toNodeHandler +
// Express. Adapting it would mean constructing a throwaway Request per call for
// what is one string comparison.
//
// HOST IS DELIBERATELY NOT VALIDATED. Only Origin is a MUST. Behind Railway's
// proxy the Host header is the public hostname, but internal health probes and
// self-host reverse proxies legitimately present others, so validating it would
// 403 real traffic for no added protection — /mcp is bearer-only with no cookie
// or ambient credential, so a rebinding attacker gains nothing to begin with.
// This is a decision, not an oversight; revisit it only if /mcp ever accepts an
// ambient credential.
//
// OBSERVABILITY: the Origin header is attacker-controlled, so only the OUTCOME
// is logged, never the raw value — the same posture mcp-header-observability.ts
// takes toward Mcp-Method / Mcp-Name.
import { isAllowedMcpOrigin, log } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'

/**
 * JSON-RPC error body for a rejected origin. Carries `id: null` because the
 * request is refused BEFORE the body is trusted as a JSON-RPC message, so there
 * is no request id to echo — the shape the spec permits for a transport-level
 * rejection. `-32600` is Invalid Request.
 */
const FORBIDDEN_BODY = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32_600, message: 'Origin not allowed' },
} as const

/**
 * Reject a /mcp request whose Origin is present and not allowlisted. Mounted
 * FIRST on the /mcp route — ahead of oauthBearerAuth and the per-user limiter —
 * so a foreign origin never reaches authentication and never consumes a
 * rate-limit point.
 *
 * The allowlist itself lives in @3ngram/config (WEB_APP_URL ∪
 * MCP_ALLOWED_ORIGINS); this middleware holds no policy of its own beyond the
 * present/absent branch. With nothing configured the allowlist is empty and
 * every present Origin is rejected — fail-closed, and harmless for the
 * non-browser clients that send none.
 */
export function mcpOriginValidation(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin')
  if (origin === undefined) {
    next()
    return
  }
  if (isAllowedMcpOrigin(origin)) {
    next()
    return
  }
  log().warn({ surface: 'mcp' }, 'mcp: rejected request from a non-allowlisted origin')
  res.status(403).json(FORBIDDEN_BODY)
}
