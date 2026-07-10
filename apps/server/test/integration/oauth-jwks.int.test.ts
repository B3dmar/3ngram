// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — JWKS rotation (cases 11-12: rotation untested is
// rotation broken). Old-key tokens stay valid while the key remains in the set,
// dropped-key tokens are rejected, and new flows sign with the new front key.
// This suite mutates process.env.OAUTH_JWKS and restarts the in-process app via
// the harness; it owns its own context, so the restarts never leak to other files
// (integration runs with --fileParallelism=false). Shared scaffolding lives in
// oauth-conformance.helpers.ts. Pure split of oauth-conformance.int.test.ts;
// no behavior or assertion changes.
import { exportJWK, generateKeyPair } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_JWKS, TEST_PRIVATE_JWK } from '../oauth-token-helper.js'
import { type OAuthConformanceContext, setupConformance } from './oauth-conformance.helpers.js'

let ctx: OAuthConformanceContext
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ ctx, teardown } = await setupConformance())
})

afterAll(async () => {
  await teardown()
})

describe('S4 conformance 11-12: JWKS rotation (rotation untested is rotation broken)', () => {
  it('keeps old-key tokens valid while the key stays in the set, drops them when it leaves, and signs with the new key', async () => {
    // Token minted under k1 by the original app.
    const oldKeyTokens = await ctx.fullFlow()

    // Rotate: a fresh k2 goes to the FRONT (signs), k1 stays behind (verifies).
    const pair = await generateKeyPair('RS256', { extractable: true })
    const k2 = {
      ...(await exportJWK(pair.privateKey)),
      ...(await exportJWK(pair.publicKey)),
      kty: 'RSA',
      alg: 'RS256',
      kid: 'k2',
    }
    process.env.OAUTH_JWKS = JSON.stringify([k2, TEST_PRIVATE_JWK])
    await ctx.restartApp() // restartApp re-reads env (resetEnvCache + relisten)

    // Case 11: the k1-signed token still verifies after rotation.
    expect(await ctx.mcpStatus(oldKeyTokens.access_token)).not.toBe(401)

    // A new flow now signs with k2 (the first key) — accepted by the RS.
    const newKeyTokens = await ctx.fullFlow()
    const kid = (
      JSON.parse(
        Buffer.from(newKeyTokens.access_token.split('.')[0] as string, 'base64url').toString(),
      ) as { kid: string }
    ).kid
    expect(kid).toBe('k2')
    expect(await ctx.mcpStatus(newKeyTokens.access_token)).not.toBe(401)

    // Case 12: drop k1 entirely — its tokens are rejected; k2 tokens keep working.
    process.env.OAUTH_JWKS = JSON.stringify([k2])
    await ctx.restartApp()
    expect(await ctx.mcpStatus(oldKeyTokens.access_token)).toBe(401)
    expect(await ctx.mcpStatus(newKeyTokens.access_token)).not.toBe(401)

    // Restore the original key set for any later suite state.
    process.env.OAUTH_JWKS = TEST_JWKS
    await ctx.restartApp()
  })
})
