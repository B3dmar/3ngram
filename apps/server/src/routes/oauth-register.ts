// SPDX-License-Identifier: Apache-2.0
// RFC 7591 dynamic client registration transport. Thin by contract:
// validate at the one boundary
// (clientRegistrationInputSchema), delegate policy (id/secret minting, hashing,
// persistence) to packages/core, shape the RFC 7591 response.
//
// Status contract (RFC 7591 §3.2):
//   201 — the registered metadata. A confidential client's client_secret is
//         returned ONCE here, under Cache-Control: no-store, and is never
//         logged or retrievable again (only its SHA-256 hash is at rest).
//         Public clients ('none') get client_id only.
//   400 — { error: 'invalid_redirect_uri' } for redirect_uris failures
//         (non-https outside localhost/127.0.0.1, fragments, empty array),
//         { error: 'invalid_client_metadata' } for everything else (unknown
//         token_endpoint_auth_method included) — the schema enum pre-empts the
//         0005 DB CHECKs so a violation never surfaces as a raw pg error.
//
// RATE LIMIT: a per-IP limiter seam runs before the handler (resolveLimiters,
// app.ts). The default is a real per-IP bucket (this endpoint is
// unauthenticated); the injection seam owns the final policy.
import { log } from '@3ngram/config'
import { insertAuditLog, registerOAuthClient } from '@3ngram/core/auth'
import { clientRegistrationInputSchema } from '@3ngram/schema'
import { Router } from 'express'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'

/** Options the boot wiring injects: the per-IP rate limiter seam. */
export interface OAuthRegisterRouterOptions {
  limiter: RateLimiterMiddleware
}

/** Map a Zod failure to its RFC 7591 §3.2.2 error code: redirect_uris issues get the dedicated code. */
function registrationErrorCode(issues: ReadonlyArray<{ path: PropertyKey[] }>): string {
  return issues.some((issue) => issue.path[0] === 'redirect_uris')
    ? 'invalid_redirect_uri'
    : 'invalid_client_metadata'
}

/** Build the /oauth/register router with the injected per-IP limiter gating it. */
export function oauthRegisterRouter(options: OAuthRegisterRouterOptions): Router {
  const router = Router()

  router.post('/oauth/register', options.limiter, (req, res, next) => {
    const parsed = clientRegistrationInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: registrationErrorCode(parsed.error.issues) })
      return
    }
    registerOAuthClient(parsed.data)
      .then((client) => {
        res.setHeader('Cache-Control', 'no-store')
        res.status(201).json(client)
        // Fire-and-forget: audit the registration event. NEVER include
        // client_secret — only the sanitised client_id (hard rule 6).
        insertAuditLog({
          actorKind: 'system',
          action: 'dcr.register',
          resource: client.client_id,
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
        }).catch((err: unknown) => {
          log().warn(
            { err: err instanceof Error ? err.name : 'unknown' },
            'audit: dcr.register failed',
          )
        })
      })
      .catch(next)
  })

  return router
}
