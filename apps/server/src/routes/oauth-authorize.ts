// SPDX-License-Identifier: Apache-2.0
// /oauth/authorize transport. Thin by contract: validate at the one boundary
// (authorizeRequestSchema / consentSubmissionSchema), delegate redirect-URI
// matching + code issuance to packages/core, render the combined
// credentials+consent form (ONE server-rendered form, no separate
// session/cookie infra; consent persistence is deferred).
//
// Status contract:
//   GET  200 the consent form; 400 for a schema-invalid request, an unknown
//        client_id, or a redirect_uri that does not BYTE-EXACTLY match a
//        registered one (never a redirect to an unvetted URI — exact match, no path/query/port relaxation).
//   POST 302 to the registered redirect_uri with code+state on success;
//        400/403 (schema / CSRF) as above; 401 re-renders the form on wrong
//        credentials (uniform — no user enumeration, login() handles timing).
//
// CSRF (same-site + token): a double-submit pair — the GET mints
// a CSPRNG token into BOTH a SameSite=Lax HttpOnly cookie and a hidden field;
// the POST requires them to match (timing-safe). Threat model per the ADR:
// the form shows the redirect HOST next to the client name (look-alike-name
// phishing) and only the two v1 scopes exist (consent fatigue).
//
// Never log credentials, codes, or CSRF tokens.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { loadOAuthConfig } from '@3ngram/config'
import {
  type ClientMetadataResolver,
  createOAuthServerProvider,
  EmailNotVerifiedError,
  MEMORY_READ_SCOPE,
  MEMORY_WRITE_SCOPE,
  type OAuthClientInformation,
  resolveOAuthClient,
  resolveRegisteredRedirectUri,
  verifyCredentials,
} from '@3ngram/core/auth'
import {
  type AuthorizeRequest,
  authorizeRequestSchema,
  consentSubmissionSchema,
} from '@3ngram/schema'
import { type Request, type Response, Router, urlencoded } from 'express'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'

/** Options the boot wiring injects: the per-IP rate limiter seam. */
export interface OAuthAuthorizeRouterOptions {
  limiter: RateLimiterMiddleware
  clientMetadataResolver: ClientMetadataResolver
}

const CSRF_COOKIE = 'oauth_csrf'
const CSRF_TTL_MS = 600_000

/** Minimal cookie read for the one CSRF cookie — no cookie-parser dependency. */
function readCsrfCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === CSRF_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Timing-safe equality over the double-submit pair. */
function csrfMatches(cookieValue: string | undefined, fieldValue: string): boolean {
  if (cookieValue === undefined) return false
  const a = Buffer.from(cookieValue)
  const b = Buffer.from(fieldValue)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Mint the CSRF pair: sets the same-site cookie, returns the hidden-field value. */
function issueCsrfToken(req: Request, res: Response): string {
  const token = randomBytes(32).toString('base64url')
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: CSRF_TTL_MS,
    path: '/oauth/authorize',
  })
  return token
}

/** Escape a value for interpolation into HTML text or a double-quoted attribute. */
function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return value.replace(/[&<>"']/g, (c) => map[c] as string)
}

/** Serialize the OAuth request params as hidden fields (escaped; absent = omitted). */
function hiddenFields(
  params: AuthorizeRequest,
  redirectUri: string,
  redirectUriSupplied: boolean,
  csrfToken: string,
): string {
  const fields: Record<string, string | undefined> = {
    client_id: params.client_id,
    redirect_uri: redirectUri,
    // RFC 6749 §4.1.3: the redirect_uri field above carries the
    // RESOLVED URI, so its presence in the POST cannot reveal whether the client
    // SUPPLIED redirect_uri at /authorize. Mint that fact here, GET-time, into a
    // distinct field the POST reads back (see resolveConsentTarget).
    redirect_uri_was_supplied: redirectUriSupplied ? '1' : undefined,
    response_type: params.response_type,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    scope: params.scope,
    state: params.state,
    resource: params.resource,
    csrf_token: csrfToken,
  }
  return Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('\n      ')
}

interface ConsentView {
  client: OAuthClientInformation
  params: AuthorizeRequest
  redirectUri: string
  redirectUriSupplied: boolean
  csrfToken: string
  error?: string
}

function clientMetadataHost(clientId: string): string | undefined {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' ? url.host : undefined
  } catch {
    return undefined
  }
}

/** Render the combined credentials + consent page (client name, redirect HOST, scopes). */
function renderConsentPage(view: ConsentView): string {
  const scopes = view.params.scope ?? `${MEMORY_READ_SCOPE} ${MEMORY_WRITE_SCOPE}`
  const scopeItems = scopes
    .split(' ')
    .map((s) => `<li><code>${escapeHtml(s)}</code></li>`)
    .join('')
  const errorLine = view.error === undefined ? '' : `<p class="error">${escapeHtml(view.error)}</p>`
  const metadataHost = clientMetadataHost(view.client.client_id)
  const clientIdentity =
    metadataHost === undefined ? '' : `metadata from ${escapeHtml(metadataHost)}; `
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(view.client.client_name)} — 3ngram</title>
<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
label{display:block;margin:.75rem 0 .25rem}input{width:100%;padding:.5rem;box-sizing:border-box}
button{margin-top:1rem;padding:.6rem 1.2rem;cursor:pointer}.host{color:#555}.error{color:#b00020}</style></head>
<body>
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(view.client.client_name)}</strong>
  <span class="host">(${clientIdentity}redirects to ${escapeHtml(new URL(view.redirectUri).host)})</span>
  is requesting access to your 3ngram memory:</p>
  <ul>${scopeItems}</ul>
  ${errorLine}
  <form method="post" action="/oauth/authorize">
      ${hiddenFields(view.params, view.redirectUri, view.redirectUriSupplied, view.csrfToken)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in &amp; approve</button>
  </form>
</body></html>`
}

/**
 * Resolve client + redirect URI for a validated request, or undefined when the
 * client is unknown / the redirect_uri is not registered. The 400 is emitted by
 * the caller — NEVER a redirect (the URI is unvetted by definition here).
 */
async function resolveConsentTarget(
  params: AuthorizeRequest,
  redirectUriSupplied: boolean,
  clientMetadataResolver: ClientMetadataResolver,
): Promise<
  { client: OAuthClientInformation; redirectUri: string; redirectUriSupplied: boolean } | undefined
> {
  const client = await resolveOAuthClient(params.client_id, clientMetadataResolver)
  if (client === undefined || !client.grant_types.includes('authorization_code')) return undefined
  const redirectUri = resolveRegisteredRedirectUri(client, params.redirect_uri)
  if (redirectUri === undefined) return undefined
  // RFC 6749 §4.1.3: supplied-ness is captured at the INITIAL GET
  // /authorize (whether the CLIENT's request carried redirect_uri) and threaded
  // through the consent form — NOT derived from the POST's redirect_uri, which
  // always carries the RESOLVED URI as a hidden field. Pure pass-through of the
  // caller-supplied flag; the RFC decision stays in core.
  return { client, redirectUri, redirectUriSupplied }
}

/** GET: validate, then serve the consent form with a fresh CSRF pair. */
async function handleAuthorizeGet(
  req: Request,
  res: Response,
  clientMetadataResolver: ClientMetadataResolver,
): Promise<void> {
  const parsed = authorizeRequestSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  // Capture supplied-ness from the CLIENT's authorize request here, GET-time —
  // this is the only point that sees whether redirect_uri was actually sent.
  const target = await resolveConsentTarget(
    parsed.data,
    parsed.data.redirect_uri !== undefined,
    clientMetadataResolver,
  )
  if (target === undefined) {
    res.status(400).json({ error: 'invalid_client' })
    return
  }
  const csrfToken = issueCsrfToken(req, res)
  res
    .status(200)
    .type('html')
    .send(renderConsentPage({ ...target, params: parsed.data, csrfToken }))
}

/** POST: CSRF + credentials, then issue the code and 302 back with state. */
async function handleConsentPost(
  req: Request,
  res: Response,
  clientMetadataResolver: ClientMetadataResolver,
): Promise<void> {
  const parsed = consentSubmissionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  // Read supplied-ness from the GET-time hidden field — NOT from the POST's
  // redirect_uri, which always carries the resolved URI.
  const target = await resolveConsentTarget(
    parsed.data,
    parsed.data.redirect_uri_was_supplied === '1',
    clientMetadataResolver,
  )
  if (target === undefined) {
    res.status(400).json({ error: 'invalid_client' })
    return
  }
  if (!csrfMatches(readCsrfCookie(req.header('cookie')), parsed.data.csrf_token)) {
    res.status(403).json({ error: 'invalid_request' })
    return
  }
  const config = loadOAuthConfig()
  if (
    parsed.data.resource !== undefined &&
    new URL(parsed.data.resource).href !== config.resource
  ) {
    res.status(400).json({ error: 'invalid_target' })
    return
  }
  // Consent only needs to confirm identity, not establish a session — calling
  // verifyCredentials (not login) avoids leaving an orphan sessions row whose
  // plaintext token would be discarded.
  let userId: string | undefined
  try {
    userId = await verifyCredentials(parsed.data.email, parsed.data.password)
  } catch (error) {
    if (!(error instanceof EmailNotVerifiedError)) throw error
    const csrfToken = issueCsrfToken(req, res)
    res
      .status(403)
      .type('html')
      .send(
        renderConsentPage({
          ...target,
          params: parsed.data,
          csrfToken,
          error: 'Verify your email before connecting a client.',
        }),
      )
    return
  }
  if (userId === undefined) {
    const csrfToken = issueCsrfToken(req, res)
    res
      .status(401)
      .type('html')
      .send(
        renderConsentPage({
          ...target,
          params: parsed.data,
          csrfToken,
          error: 'Invalid email or password.',
        }),
      )
    return
  }
  await createOAuthServerProvider(config).authorize(
    target.client,
    {
      userId,
      codeChallenge: parsed.data.code_challenge,
      redirectUri: target.redirectUri,
      redirectUriSupplied: target.redirectUriSupplied,
      ...(parsed.data.scope === undefined ? {} : { scopes: parsed.data.scope.split(' ') }),
      ...(parsed.data.state === undefined ? {} : { state: parsed.data.state }),
    },
    res,
  )
}

/** Build the /oauth/authorize router behind the injected per-IP limiter. */
export function oauthAuthorizeRouter(options: OAuthAuthorizeRouterOptions): Router {
  const router = Router()
  router.get('/oauth/authorize', options.limiter, (req, res, next) => {
    handleAuthorizeGet(req, res, options.clientMetadataResolver).catch(next)
  })
  router.post(
    '/oauth/authorize',
    options.limiter,
    urlencoded({ extended: false }),
    (req, res, next) => {
      handleConsentPost(req, res, options.clientMetadataResolver).catch(next)
    },
  )
  return router
}
