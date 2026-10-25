// SPDX-License-Identifier: Apache-2.0
// Tenant settings transports. Authentication is mounted by restRouter before
// this child router; what a setting means lives in core.
//
// GET/PUT /api/v1/settings/judgment — the judgment opt-in (issue #225): whether
// this tenant's derived text may be sent to the judgment provider. Default off.
//
// DELIBERATELY UNGATED (no AccessGate assertion), like GET /api/v1/budget: this
// is a privacy setting, not memory or memory-derived data, and opting OUT must
// stay possible for an account the gate is denying. The setting alone sends
// nothing; a deployment must also configure JEV_*.
import { getJudgmentPolicy, type JudgmentPolicySetting, setJudgmentPolicy } from '@3ngram/core'
import { judgmentPolicyBodySchema } from '@3ngram/schema'
import { Router } from 'express'
import { guard, tenant } from './route-helpers.js'

function judgmentResponse(setting: JudgmentPolicySetting) {
  return { mode: setting.mode, updatedAt: setting.updatedAt?.toISOString() ?? null }
}

export function settingsRouter(): Router {
  const router = Router()

  router.get('/api/v1/settings/judgment', (req, res) => {
    void guard('settings.judgment.get', res, async () => {
      res.status(200).json(judgmentResponse(await getJudgmentPolicy(tenant(req))))
    })
  })

  router.put('/api/v1/settings/judgment', (req, res) => {
    void guard('settings.judgment.put', res, async () => {
      const body = judgmentPolicyBodySchema.parse(req.body)
      const stored = await setJudgmentPolicy(tenant(req), body.mode, 'user_api')
      res.status(200).json(judgmentResponse(stored))
    })
  })

  return router
}
