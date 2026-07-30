// SPDX-License-Identifier: Apache-2.0
// Bearer-token authentication (auth C2). Reads `Authorization: Bearer <token>`,
// resolves it through the core session service, and binds the identity for the
// rest of the request. A missing/garbage/expired token is a uniform 401 — the
// route never sees an unauthenticated request.
//
// The raw user id is attached to req.userId (route handlers feed it to
// withTenant); only its HASH enters the log context (hard rule 6). The token
// itself is never logged.
import { bindContext, hashUserId } from '@3ngram/config'
import { authenticateToken } from '@3ngram/core/auth'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { NextFunction, Request, Response } from 'express'

// The authenticated identity, attached once here and consumed by route
// handlers (which pass it to withTenant). Declared on Express's Request so the
// whole app shares one typed contract.
declare module 'express' {
  interface Request {
    userId?: string
    // The OAuth scopes granted to a Bearer token, parsed from the verified
    // token's space-separated `scope` claim by oauthBearerAuth. Absent for the
    // session / api-key paths (which carry no OAuth scope). Per-tool scope
    // enforcement reads this; absence/empty means NO write.
    oauthScopes?: readonly string[]
    // MCP SDK v2's Node adapter forwards this already-verified auth context to
    // the per-request protocol handler. Only oauthBearerAuth populates it.
    auth?: AuthInfo
    // The prefix segment of the raw API key (`3ng_<prefix>_<secret>`), set by
    // apiKeyAuth. Used by the per-key rate-limiter bucket on /api/*;
    // absent for Bearer paths that never pass an X-API-Key header.
    apiKeyId?: string
  }
}

const BEARER_PREFIX = 'Bearer '

/**
 * Extract the token from a well-formed Authorization header, else undefined.
 * The auth-scheme is matched case-insensitively (RFC 7235 §2.1: scheme names
 * are case-insensitive), but the token bytes after the prefix are taken
 * unchanged.
 */
export function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return undefined
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : undefined
}

/**
 * Authenticate the request. On success binds req.userId and the hashed id into
 * the log context, then continues; otherwise responds 401 and stops. Errors
 * from the resolver bubble to the app error handler (500), not a silent pass.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req.header('authorization'))
  if (token === undefined) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  authenticateToken(token)
    .then((userId) => {
      if (userId === undefined) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      req.userId = userId
      bindContext({ userIdHash: hashUserId(userId) })
      next()
    })
    .catch(next)
}
