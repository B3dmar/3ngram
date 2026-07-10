// SPDX-License-Identifier: Apache-2.0
// OAuth grant-management transport (consent UI). Thin by
// contract: validate at the one boundary (oauthClientIdParamSchema),
// delegate listing / revocation to packages/core, shape the HTTP response. No
// business logic here. Both routes sit behind the C2 `authenticate` middleware,
// so req.userId is the session-authenticated owner and consent stays
// grant-scoped — a user can only ever see/revoke the clients THEY authorized
// (the db helpers RLS-scope the read/write to the caller's oauth_tokens).
//
// Status contract:
//   GET    /auth/oauth-clients            200 { clients: [...metadata] } — the
//                             caller's authorized clients; name + redirect hosts
//                             + authorizedAt only, NEVER any secret material.
//   DELETE /auth/oauth-clients/:clientId  204 on revoke (caller's tokens for the
//                             client killed) AND when nothing matched (unknown,
//                             not-authorized, already revoked) — idempotent, so a
//                             double-click is never a spurious error; the global
//                             client row is never touched.
import { listAuthorizedClients, revokeAuthorizedClient } from '@3ngram/core/auth'
import { oauthClientIdParamSchema } from '@3ngram/schema'
import { type NextFunction, type Request, type Response, Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'

export const oauthClientsRouter: Router = Router()

// authenticate guarantees req.userId is bound before each handler runs; the
// non-null assertion is safe because an unauthenticated request never reaches
// here (the middleware 401s first).
oauthClientsRouter.get(
  '/auth/oauth-clients',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    listAuthorizedClients(req.userId as string)
      .then((clients) => {
        res.status(200).json({
          clients: clients.map((c) => ({
            clientId: c.clientId,
            clientName: c.clientName,
            redirectHosts: c.redirectHosts,
            authorizedAt: c.authorizedAt.toISOString(),
          })),
        })
      })
      .catch(next)
  },
)

oauthClientsRouter.delete(
  '/auth/oauth-clients/:clientId',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    // A malformed (non-uuid) client_id can never match a stored grant; treat it
    // as the same idempotent no-op as an unknown/already-revoked grant (204)
    // rather than forwarding it where a uuid cast would raise a generic 500.
    const clientId = oauthClientIdParamSchema.safeParse(req.params.clientId)
    if (!clientId.success) {
      res.status(204).end()
      return
    }
    revokeAuthorizedClient(req.userId as string, clientId.data)
      .then(() => {
        // Revoke is idempotent: whether a live grant was closed or none matched,
        // the desired end state (the caller holds no grant for this client) now
        // holds, so both map to 204.
        res.status(204).end()
      })
      .catch(next)
  },
)
