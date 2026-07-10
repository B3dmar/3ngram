// SPDX-License-Identifier: Apache-2.0
// OAuth Bearer-JWT authentication (auth C4b). Reads `Authorization: Bearer <jwt>`,
// verifies it as an RS256 access token against the local JWKS + revocation check
// (core verifyAccessToken), and binds the identity for the rest of the request —
// the SAME req.userId + log-context shape the C2 `authenticate` and C3
// `apiKeyAuth` middlewares use, so all three coexist transparently downstream.
//
// STATUS CONTRACT (RFC 6750 + RFC 9728 §5.1):
//   200  valid token -> identity bound, next() runs the route
//   401  missing / malformed / invalid / wrong-aud / wrong-iss / expired /
//        unknown-kid / revoked token, with a `WWW-Authenticate: Bearer` header.
//        A missing header omits error params (RFC 6750 §3: a bare challenge); a
//        present-but-invalid token carries error="invalid_token". EVERY
//        challenge carries `resource_metadata="<RFC 9728 well-known URL>"` —
//        the MCP authorization spec (2025-06-18 revision) REQUIRES the 401 to
//        point clients at the protected-resource metadata; without it the
//        Claude Code client cannot locate the AS to run the refresh_token
//        grant and falls back to interactive re-auth at every access expiry.
//   503  verifier/DB failure (JWKS unreachable, resolver down) — caught LOCALLY,
//        never forwarded to next() (which would become a generic 500 and break
//        this contract, C3 precedent).
//
// The raw user id is attached to req.userId; only its HASH enters the log
// context (hard rule 6). The token and its claims are never logged.
import { bindContext, hashUserId, loadOAuthConfig, log } from '@3ngram/config'
import { parseScopes, verifyAccessToken } from '@3ngram/core/auth'
import type { NextFunction, Request, Response } from 'express'

const BEARER_PREFIX = 'Bearer '

/** The OAuth scopes that protected resources advertise on a challenge. */
const RESOURCE_REALM = 'mcp'

/**
 * Extract the token from a well-formed Authorization header, else undefined.
 * Scheme matched case-insensitively (RFC 7235 §2.1); token
 * bytes after the prefix are taken unchanged.
 */
function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return undefined
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : undefined
}

/**
 * RFC 9728 §3.1: the protected-resource metadata URL inserts the well-known
 * segment between the resource's origin and its path, so the `/mcp` resource
 * is discovered at `/.well-known/oauth-protected-resource/mcp` (the document
 * routes/well-known.ts serves). Pure derivation — no business logic. Returns
 * undefined when the OAuth config is unavailable: a 401 challenge must stay a
 * 401 even with a half-configured server (the verify path surfaces the config
 * failure as its own 503); in production loadOAuthConfig always resolves.
 */
function resourceMetadataUrl(): string | undefined {
  try {
    const url = new URL(loadOAuthConfig().resource)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.origin}/.well-known/oauth-protected-resource${path}`
  } catch {
    return undefined
  }
}

/**
 * Emit an RFC 6750 401. A bare challenge (no token presented) carries no error
 * params; a rejected token carries error="invalid_token" + a human
 * description. Every challenge carries the RFC 9728 §5.1 `resource_metadata`
 * pointer (MCP authorization spec, 2025-06-18 revision) so a client holding a
 * refresh token can rediscover the AS and refresh non-interactively.
 * No token material or claim values enter the header (hard rule 6).
 */
function challenge(res: Response, error?: 'invalid_token'): void {
  const params = [`realm="${RESOURCE_REALM}"`]
  if (error !== undefined) {
    params.push(`error="${error}"`, 'error_description="The access token is invalid"')
  }
  const metadataUrl = resourceMetadataUrl()
  if (metadataUrl !== undefined) params.push(`resource_metadata="${metadataUrl}"`)
  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`)
  res.status(401).json({ error: error ?? 'unauthorized' })
}

/**
 * Authenticate the request via a Bearer JWT. On success binds req.userId + the
 * hashed id into the log context and continues. A missing token is a bare 401
 * challenge; an invalid token is a 401 with error="invalid_token"; any
 * verifier/DB failure is a 503 emitted here (never a leaked 500).
 */
export function oauthBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req.header('authorization'))
  if (token === undefined) {
    challenge(res)
    return
  }
  verifyAccessToken(token, loadOAuthConfig())
    .then((result) => {
      if (!result.ok) {
        challenge(res, 'invalid_token')
        return
      }
      req.userId = result.token.userId
      // Bind the verified token's granted scopes (RFC 6749 space-delimited
      // `scope`) for per-tool enforcement downstream. FAIL-CLOSED:
      // a token with no/empty scope claim yields an empty set, so a later
      // memory:write check fails. Scope VALUES are not content, but they are not
      // logged either (only the user-id hash enters the log context).
      req.oauthScopes = [...parseScopes(result.token.scope)]
      bindContext({ userIdHash: hashUserId(result.token.userId) })
      next()
    })
    .catch((err: unknown) => {
      // Verifier or DB failure: emit the 503 contract HERE. Forwarding to next()
      // would hit the generic 500 handler and break the status contract.
      log().error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'oauth-bearer: verifier unavailable',
      )
      res.status(503).json({ error: 'service_unavailable' })
    })
}
