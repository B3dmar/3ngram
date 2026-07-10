// SPDX-License-Identifier: Apache-2.0
import { Router } from 'express'

/**
 * Liveness only — no DB hit (the S5 capture hook polls this on every tool
 * call; its latency budget rules out a round-trip). Readiness with a DB ping
 * arrives with the first DB-backed route (Phase 1C2).
 */
export const healthRouter: Router = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})
