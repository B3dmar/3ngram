// SPDX-License-Identifier: Apache-2.0
// Onboarding status transport.
// Thin by contract: delegate the "has this user connected an
// agent yet" decision to packages/core (getOnboardingStatus), shape the HTTP
// response. No business logic here. The route sits behind the `authenticate`
// middleware, so req.userId is the session-authenticated owner — the dashboard
// polls it (session bearer) to flip the connect step to "Connected ✓".
//
// Status contract:
//   GET  /auth/onboarding        200 { connected: boolean } — true once the
//                                caller has been issued their first OAuth token.
//   POST /auth/onboarding/seed   204 — idempotently (re-)provision the caller's
//                                default scopes + welcome memory. The
//                                first-run dashboard calls this when the seed was
//                                deferred/failed at verification, then gates on
//                                the welcome memory existing — never a blank first
//                                run. Idempotent: a re-run on an already
//                                seeded account is a no-op (the core helper
//                                swallows the scope/duplicate conflicts).
import type { LimitsResolver } from '@3ngram/core'
import {
  getOnboardingStatus,
  provisionVerifiedAccount,
  ResourceLimitExceededError,
} from '@3ngram/core/auth'
import { type NextFunction, type Request, type Response, Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'

export interface OnboardingSeedError {
  status: 409
  error: 'resource_limit_exceeded'
}

/** Map the one expected seed denial without exposing policy details. */
export function mapOnboardingSeedError(error: unknown): OnboardingSeedError | undefined {
  return error instanceof ResourceLimitExceededError
    ? { status: 409, error: 'resource_limit_exceeded' }
    : undefined
}

/** Build onboarding routes with the same resource policy as normal writes. */
export function onboardingRouter(limits?: LimitsResolver): Router {
  const router = Router()

  // authenticate guarantees req.userId is bound before each handler runs; the
  // non-null assertion is safe because an unauthenticated request never reaches
  // here (the middleware 401s first).
  router.get(
    '/auth/onboarding',
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      getOnboardingStatus(req.userId as string)
        .then((status) => {
          res.status(200).json({ connected: status.connected })
        })
        .catch(next)
    },
  )

  router.post(
    '/auth/onboarding/seed',
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      // Idempotent re-seed: provisionVerifiedAccount swallows the scope/duplicate
      // conflicts, so a call against an already-seeded account is a no-op. No
      // embedding gateway is threaded here — the welcome memory is stored with a
      // NULL embedding (still listable / FTS-searchable, backfillable later), which
      // is enough for the non-empty first-run guarantee.
      provisionVerifiedAccount(req.userId as string, { limits })
        .then(() => {
          res.status(204).end()
        })
        .catch((error: unknown) => {
          const mapped = mapOnboardingSeedError(error)
          if (mapped !== undefined) {
            res.status(mapped.status).json({ error: mapped.error })
            return
          }
          next(error)
        })
    },
  )
  return router
}
