// SPDX-License-Identifier: Apache-2.0
// Onboarding "About you" profiling transport. Thin by
// contract: validate the body at the boundary, delegate to
// packages/core, shape the HTTP response. Behind the `authenticate`
// middleware, so req.userId is the session-authenticated owner.
//
//   GET /auth/profile   200 {role?,useCase?,aiTools?,referralSource?} — {} if unset
//   PUT /auth/profile   204 — upsert the (all-optional) attributes; 400 on a body
//                       that fails userProfileAttributesSchema (single validation
//                       boundary, hard rule 2).
import { getUserProfile, setUserProfile } from '@3ngram/core/auth'
import { userProfileAttributesSchema } from '@3ngram/schema'
import { type NextFunction, type Request, type Response, Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'

export const profileRouter: Router = Router()

profileRouter.get(
  '/auth/profile',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    getUserProfile(req.userId as string)
      .then((attrs) => {
        res.status(200).json(attrs ?? {})
      })
      .catch(next)
  },
)

profileRouter.put(
  '/auth/profile',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    const parsed = userProfileAttributesSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_profile' })
      return
    }
    setUserProfile(req.userId as string, parsed.data)
      .then(() => {
        res.status(204).end()
      })
      .catch(next)
  },
)
