// SPDX-License-Identifier: Apache-2.0
// API-key management transport (auth C3). Thin by contract (hard rule 5):
// validate at the one boundary (issueApiKeyInputSchema), delegate issuance /
// listing / revocation to packages/core, shape the HTTP response. No business
// logic here. All three routes sit behind the C2 `authenticate` middleware, so
// req.userId is the session-authenticated owner.
//
// Status contract:
//   POST   /auth/api-keys     201 { id, key, prefix, name, createdAt } — the
//                             plaintext `key` is returned ONCE and never logged;
//                             400 on a schema-invalid body (missing/blank name).
//   GET    /auth/api-keys     200 { keys: [...metadata] } — name/prefix/
//                             timestamps only, NEVER the key hash.
//   DELETE /auth/api-keys/:id 204 on revoke; 404 when the id is unknown,
//                             not-owned, or already revoked.
import { issueApiKey, listApiKeys, revokeApiKey } from '@3ngram/core/auth'
import { apiKeyIdSchema, issueApiKeyInputSchema } from '@3ngram/schema'
import { type NextFunction, type Request, type Response, Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'

export const apiKeysRouter: Router = Router()

// authenticate guarantees req.userId is bound before each handler runs; the
// non-null assertion is safe because an unauthenticated request never reaches
// here (the middleware 401s first).
apiKeysRouter.post(
  '/auth/api-keys',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    const parsed = issueApiKeyInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    issueApiKey(req.userId as string, parsed.data.name)
      .then((issued) => {
        res.status(201).json({
          id: issued.id,
          key: issued.key,
          prefix: issued.prefix,
          name: issued.name,
          createdAt: issued.createdAt.toISOString(),
        })
      })
      .catch(next)
  },
)

apiKeysRouter.get(
  '/auth/api-keys',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    listApiKeys(req.userId as string)
      .then((keys) => {
        res.status(200).json({
          keys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            createdAt: k.createdAt.toISOString(),
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            revokedAt: k.revokedAt?.toISOString() ?? null,
          })),
        })
      })
      .catch(next)
  },
)

apiKeysRouter.delete(
  '/auth/api-keys/:id',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    // A malformed id can never match a stored uuid, so treat it the same as an
    // unknown id (404) instead of letting Postgres raise a uuid cast error that
    // .catch(next) would surface as a generic 500.
    const id = apiKeyIdSchema.safeParse(req.params.id)
    if (!id.success) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    revokeApiKey(req.userId as string, id.data)
      .then((revoked) => {
        if (!revoked) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        res.status(204).end()
      })
      .catch(next)
  },
)
