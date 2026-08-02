// SPDX-License-Identifier: Apache-2.0
// S4 OAuth AS conformance — the strict RS fails closed (cases 7-8: wrong-aud and
// revoked access tokens rejected at /mcp) and refresh rotation (cases 9-10:
// revoked refresh cannot rotate, rotation is one-time, plus scope narrowing never
// re-broadens). Shared scaffolding lives in oauth-conformance.helpers.ts. Pure
// split of oauth-conformance.int.test.ts; no behavior or
// assertion changes.
//
// Additional coverage: the RS 401 challenge carries the RFC 9728 §5.1
// resource_metadata pointer (MCP authorization spec, 2025-06-18 revision), and
// the full refresh lifecycle holds for a PUBLIC ('none') client — the shape a
// DCR-registered Claude Code connector uses in production.
import { contentDigest, setLogDestination } from '@3ngram/config'
import { importJWK, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_BASE_URL, TEST_ISSUER, TEST_PRIVATE_JWK } from '../oauth-token-helper.js'
import {
  type OAuthConformanceContext,
  ownerPool,
  pkcePair,
  REDIRECT_URI,
  setupConformance,
  sha256hex,
  type TokenSet,
} from './oauth-conformance.helpers.js'

let ctx: OAuthConformanceContext
let teardown: () => Promise<void>

beforeAll(async () => {
  ;({ ctx, teardown } = await setupConformance())
})

afterAll(async () => {
  await teardown()
})

describe('S4 conformance 7-8: the strict RS fails closed', () => {
  it('case 7: a wrong-aud token is rejected by the RS with 401', async () => {
    // Signed with the REAL key but aud = the issuer root, not the /mcp resource.
    const tokens = await ctx.fullFlow()
    const key = await importJWK(TEST_PRIVATE_JWK, 'RS256')
    const wrongAud = await new SignJWT({ scope: 'memory:read memory:write' })
      .setProtectedHeader({ alg: 'RS256', kid: TEST_PRIVATE_JWK.kid })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_ISSUER)
      .setSubject('11111111-1111-1111-1111-111111111111')
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() + 3_600_000))
      .sign(key)
    await ownerPool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
       SELECT $1, 'access', $2, id, 'memory:read memory:write', $3 FROM users WHERE email = $4`,
      [
        sha256hex(wrongAud),
        tokens.client.client_id,
        new Date(Date.now() + 3_600_000).toISOString(),
        ctx.email,
      ],
    )
    expect(await ctx.mcpStatus(wrongAud)).toBe(401)
  })

  it('case 8: a REVOKED access token fails closed at the RS (401)', async () => {
    const tokens = await ctx.fullFlow()
    expect(await ctx.mcpStatus(tokens.access_token)).not.toBe(401)
    await ownerPool.query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1', [
      sha256hex(tokens.access_token),
    ])
    expect(await ctx.mcpStatus(tokens.access_token)).toBe(401)
  })
})

describe('S4 conformance 9-10: refresh rotation', () => {
  it('case 9: a revoked refresh token cannot rotate', async () => {
    const tokens = await ctx.fullFlow()
    await ownerPool.query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1', [
      sha256hex(tokens.refresh_token),
    ])
    const { status, json } = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: tokens.client.client_id,
      client_secret: tokens.client.client_secret as string,
    })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_grant')
  })

  it('case 10: rotation is one-time — the predecessor is dead after rotating', async () => {
    const tokens = await ctx.fullFlow()
    const auth = {
      client_id: tokens.client.client_id,
      client_secret: tokens.client.client_secret as string,
    }
    const rotated = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      ...auth,
    })
    expect(rotated.status).toBe(200)
    const next = rotated.json as unknown as TokenSet
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(next.scope).toBe(tokens.scope)
    expect(await ctx.mcpStatus(next.access_token)).not.toBe(401)
    // Reuse of the rotated predecessor fails closed.
    const reuse = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      ...auth,
    })
    expect(reuse.status).toBe(400)
    expect(reuse.json.error).toBe('invalid_grant')
    // The successor still works exactly once more (the chain continues).
    const again = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token,
      ...auth,
    })
    expect(again.status).toBe(200)
  })

  it('narrows scope on refresh and never re-broadens (RFC 6749 §6)', async () => {
    const tokens = await ctx.fullFlow() // granted: memory:read memory:write
    const auth = {
      client_id: tokens.client.client_id,
      client_secret: tokens.client.client_secret as string,
    }
    const narrowed = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      scope: 'memory:read',
      ...auth,
    })
    expect(narrowed.status).toBe(200)
    const narrowedSet = narrowed.json as unknown as TokenSet
    expect(narrowedSet.scope).toBe('memory:read')
    // The read-only successor cannot regain memory:write on a later refresh.
    const reBroaden = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: narrowedSet.refresh_token,
      scope: 'memory:read memory:write',
      ...auth,
    })
    expect(reBroaden.status).toBe(400)
    expect(reBroaden.json.error).toBe('invalid_grant')
  })
})

describe('#239: the RS 401 challenge advertises resource_metadata (RFC 9728 §5.1)', () => {
  const metadataUrl = `${TEST_BASE_URL}/.well-known/oauth-protected-resource/mcp`

  /** Raw /mcp probe — the helpers only surface the status, the headers matter here. */
  async function mcpChallenge(headers: Record<string, string>): Promise<Response> {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    await res.text()
    return res
  }

  it('a missing token yields a bare challenge carrying the metadata pointer', async () => {
    const res = await mcpChallenge({})
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="mcp", resource_metadata="${metadataUrl}"`,
    )
  })

  it('an invalid token yields error="invalid_token" + the metadata pointer', async () => {
    const res = await mcpChallenge({ authorization: 'Bearer not.a.valid.jwt' })
    expect(res.status).toBe(401)
    const header = res.headers.get('www-authenticate')
    expect(header).toContain('error="invalid_token"')
    expect(header).toContain(`resource_metadata="${metadataUrl}"`)
  })

  it('the advertised URL dereferences to metadata naming the /mcp resource + AS', async () => {
    // The pointer must resolve WITHIN this app to the RFC 9728 document that
    // names the exact resource id (the token aud) and the issuer as its AS —
    // the discovery chain a refreshing client walks from the 401.
    const res = await fetch(`${ctx.baseUrl}${new URL(metadataUrl).pathname}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe(`${TEST_BASE_URL}/mcp`)
    expect(body.authorization_servers).toEqual([TEST_ISSUER])
  })
})

describe('#239: the refresh lifecycle holds for a PUBLIC (none) client', () => {
  it('code -> refresh -> rotation -> second refresh, no secret, RFC 8707 resource', async () => {
    // The production Claude Code connector registers via DCR; this mirrors the
    // public-client shape end-to-end: PKCE-only auth, no client_secret ever.
    const client = await ctx.registerClient('none')
    const { verifier, challenge } = pkcePair()
    const { code } = await ctx.obtainCode(client.client_id, challenge)
    const first = await ctx.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
    })
    expect(first.status).toBe(200)
    const initial = first.json as unknown as TokenSet
    const rotated = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: client.client_id,
    })
    expect(rotated.status).toBe(200)
    const next = rotated.json as unknown as TokenSet
    expect(next.refresh_token).not.toBe(initial.refresh_token)
    expect(await ctx.mcpStatus(next.access_token)).not.toBe(401)
    // The rotated predecessor is dead (one-time rotation).
    const reuse = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: client.client_id,
    })
    expect(reuse.status).toBe(400)
    expect(reuse.json.error).toBe('invalid_grant')
    // A SECOND refresh on the successor works — with the RFC 8707 resource
    // indicator a spec-conformant MCP client sends (binding must not reject it).
    const again = await ctx.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token,
      client_id: client.client_id,
      resource: `${TEST_BASE_URL}/mcp`,
    })
    expect(again.status).toBe(200)
    expect(await ctx.mcpStatus((again.json as unknown as TokenSet).access_token)).not.toBe(401)
  })
})

describe('#242: a real token mint emits the success outcome line', () => {
  interface LogLine {
    msg?: string
    [key: string]: unknown
  }

  it('logs outcome=success with a truncated client_id prefix and no token/secret', async () => {
    // The success(200) class is unreachable in the pure-transport suite (no DB);
    // here a REAL code exchange mints tokens, so capture the production log()
    // destination and assert the one outcome line the handler emits. Done on the
    // real provider path — the integration complement to oauth-token.test.ts.
    const lines: LogLine[] = []
    setLogDestination({
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine)
      },
    })
    try {
      const tokens = await ctx.fullFlow()
      const line = lines.filter((l) => l.msg === 'oauth: token endpoint').at(-1)
      expect(line?.outcome).toBe('success')
      expect(line?.grant_type).toBe('authorization_code')
      expect(line?.client_id_prefix).toBe(`sha8:${contentDigest(tokens.client.client_id)}`)
      const serialized = JSON.stringify(line)
      expect(serialized).not.toContain(tokens.access_token)
      expect(serialized).not.toContain(tokens.refresh_token)
      expect(serialized).not.toContain(tokens.client.client_id)
      if (tokens.client.client_secret !== undefined) {
        expect(serialized).not.toContain(tokens.client.client_secret)
      }
    } finally {
      setLogDestination()
    }
  })
})
