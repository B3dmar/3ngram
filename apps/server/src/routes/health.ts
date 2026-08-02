// SPDX-License-Identifier: Apache-2.0
import { log } from '@3ngram/config'
import { assertRlsInForce } from '@3ngram/core'
import { Router } from 'express'

/**
 * Liveness only — no DB hit (the S5 capture hook polls this on every tool
 * call; its latency budget rules out a round-trip). Readiness (/ready) below
 * carries the DB-backed tenant-isolation check.
 */
export const healthRouter: Router = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

/**
 * Readiness — fail-closed tenant-isolation check. Runs the runtime RLS guard
 * against the live database (current_user is the NOBYPASSRLS runtime role and
 * FORCE ROW LEVEL SECURITY is set on the tenant-data tables). If the guard
 * throws, the instance reports NOT READY (503) so the platform keeps it out of
 * rotation instead of letting a misconfigured DB serve cross-tenant reads.
 *
 * Distinct from /health: liveness must stay DB-free and cheap; readiness
 * deliberately takes the DB round-trip. Both live on healthRouter, mounted
 * before the edge limiter, so platform probes are never throttled.
 */
healthRouter.get('/ready', async (_req, res) => {
  try {
    await assertRlsInForce()
    res.json({ status: 'ready' })
  } catch (error) {
    // No silent swallow: log the specific violations, report not-ready to the
    // platform, but do NOT leak catalog/role detail in the HTTP response.
    log().error({ err: error }, 'readiness: RLS guard failed — tenant isolation not in force')
    res.status(503).json({ status: 'not-ready' })
  }
})
