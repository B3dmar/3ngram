// SPDX-License-Identifier: Apache-2.0
// Combined /api/v1 authentication: accept EITHER an X-API-Key OR
// a session Bearer token, binding the SAME req.userId either way so every
// downstream handler is auth-agnostic.
//
// WHY a combined gate: the dashboard logs in via POST /auth/login and holds a
// session Bearer token (no api key); coding agents and the capture hook hold an
// X-API-Key. Both must reach the read/inspect/admin surface, and both bind a
// userId — so a single middleware that tries one then the other keeps the routes
// thin (docs/concepts/architecture.mdx) and req.userId semantics identical to the api-key-only mount.
//
// PRECEDENCE: X-API-Key is tried FIRST (it is the established mount, and a
// present-but-invalid key is a definitive 401 — we do not fall through to the
// Bearer path on a bad key, to avoid masking a key error). Only when NO X-API-Key
// header is present do we try the Authorization: Bearer session path. When
// NEITHER credential is present it is a uniform 401.
//
// STATUS CONTRACT (mirrors the two underlying middlewares):
//   200  either credential valid  -> req.userId bound, next()
//   401  neither present, or the presented credential is invalid/expired
//   503  api-key resolver/DB failure (apiKeyAuth owns this; the Bearer path
//        bubbles its resolver error to the app handler as a 500, matching
//        authenticate.ts)
// The error semantics of each branch are inherited verbatim from apiKeyAuth /
// authenticate — this wrapper only chooses which branch runs.
import type { NextFunction, Request, Response } from 'express'
import { apiKeyAuth } from './api-key.js'
import { authenticate } from './authenticate.js'

const API_KEY_HEADER = 'x-api-key'

/**
 * Authenticate an /api/v1 request via X-API-Key OR a session Bearer token. A
 * present X-API-Key routes to the api-key gate (its 401/503 contract is
 * authoritative — a bad key never falls through to the Bearer path). Absent an
 * X-API-Key, an Authorization header routes to the session-Bearer gate. With
 * neither, it is a uniform 401. Both gates bind req.userId identically.
 */
export function apiOrSessionAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header(API_KEY_HEADER)?.trim()
  if (apiKey !== undefined && apiKey.length > 0) {
    apiKeyAuth(req, res, next)
    return
  }
  // No X-API-Key: fall back to the C2 session Bearer path. authenticate() emits
  // the uniform 401 itself when the Authorization header is missing/garbage, so
  // the no-credential case is handled there (no separate branch needed).
  authenticate(req, res, next)
}
