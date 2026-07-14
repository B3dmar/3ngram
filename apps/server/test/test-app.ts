// SPDX-License-Identifier: Apache-2.0
// Shared integration-test app factory.
//
// WHY: createApp's rate-limiter seam falls back to RateLimiterMemory with the
// PRODUCTION point ceiling when no REDIS_URL / no injected limiter is present
// (resolveLimiters). The MCP integration suite shares ONE app instance and makes
// MANY /mcp calls keyed on a single user, so the production MCP_USER_POINTS
// ceiling (120) is exhausted mid-suite and later tools/calls 429 with
// { error: 'rate_limited' }. That is a TEST-HARNESS artifact, not a product bug.
//
// FIX: integration tests build the app through this helper, which injects a NO-OP
// limiter via the EXISTING AppOptions seam (edgeLimiter/mcpLimiter/authLimiter/
// registerLimiter). Production createApp is unchanged — only the test harness
// relaxes the limiter, localized here so every integration test benefits from
// one place. Throttling itself is still proven by rate-limit.test.ts
// (RateLimiterMemory) and the /auth/login + /oauth/register 429s in
// rate-limit-wiring.test.ts — both inject their own real limiters and are
// untouched.
import type { Express } from 'express'
import { type AppOptions, createApp } from '../src/app.js'
import type { RateLimiterMiddleware } from '../src/middleware/rate-limit.js'

/** A limiter that never throttles: it consumes no points and always calls next(). */
const passThroughLimiter: RateLimiterMiddleware = (_req, _res, next) => next()

/**
 * createApp with rate limiting disabled for the integration suite. Callers may
 * still pass any AppOptions (e.g. a FakeGateway); an explicit limiter override
 * wins, so a focused test can opt back into a real limiter when it needs to.
 */
export function createTestApp(options: AppOptions = {}): Express {
  return createApp({
    edgeLimiter: passThroughLimiter,
    mcpLimiter: passThroughLimiter,
    authLimiter: passThroughLimiter,
    signupLimiter: passThroughLimiter,
    resendVerificationLimiter: passThroughLimiter,
    verifyEmailLimiter: passThroughLimiter,
    forgotPasswordLimiter: passThroughLimiter,
    resetPasswordLimiter: passThroughLimiter,
    registerLimiter: passThroughLimiter,
    oauthLimiter: passThroughLimiter,
    ...options,
  })
}
