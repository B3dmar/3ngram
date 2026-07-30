// SPDX-License-Identifier: Apache-2.0
import { ResourceLimitExceededError } from '@3ngram/core/auth'
import { InvalidGrantError } from '@modelcontextprotocol/server-legacy/auth'
import { describe, expect, it } from 'vitest'
import { RESOURCE_LIMITS_ENFORCED } from '../src/app.js'
import { toOAuthError } from '../src/routes/oauth-token.js'
import { mapOnboardingSeedError } from '../src/routes/onboarding.js'

describe('resource-limit transport mappings', () => {
  it('exports the public runtime compatibility sentinel', () => {
    expect(RESOURCE_LIMITS_ENFORCED).toBe(true)
  })

  it('maps onboarding welcome denial to HTTP 409', () => {
    expect(mapOnboardingSeedError(new ResourceLimitExceededError('live_memories'))).toEqual({
      status: 409,
      error: 'resource_limit_exceeded',
    })
  })

  it('maps active-client denial to RFC invalid_grant with a safe description', () => {
    const mapped = toOAuthError(new ResourceLimitExceededError('active_mcp_clients'))

    expect(mapped).toBeInstanceOf(InvalidGrantError)
    expect(mapped.toResponseObject()).toEqual({
      error: 'invalid_grant',
      error_description: 'Active MCP client limit reached',
    })
  })
})
