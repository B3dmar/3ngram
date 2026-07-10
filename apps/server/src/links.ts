// SPDX-License-Identifier: Apache-2.0
// Web-dashboard link builders (one home, shared by the auth routes and the
// legacy-migration launch wave). The dashboard runs on a DIFFERENT
// origin than this API server (docs/operate.mdx), so every link a
// recipient clicks MUST be built against WEB_APP_URL, never BASE_URL (the
// API/OAuth issuer, which serves none of these pages). When WEB_APP_URL is unset
// there is no web origin, so the builders return undefined and the caller skips
// the send. Tokens are credentials — callers hand these URLs to the mailer and
// never log them (hard rule 6).

/** Normalize WEB_APP_URL to an origin with no trailing slash; undefined ⇒ unset. */
export function webOrigin(webAppUrl: string | undefined): string | undefined {
  if (webAppUrl === undefined) return undefined
  return webAppUrl.endsWith('/') ? webAppUrl.slice(0, -1) : webAppUrl
}

/** `/reset-password?token=` — the set-password page reads `token` from
 * searchParams. Used by password reset AND the migrated-user reconnect flow
 * (see {@link buildReconnectLink}), which both set a password via this page. */
export function buildResetLink(webAppUrl: string | undefined, token: string): string | undefined {
  const origin = webOrigin(webAppUrl)
  return origin === undefined
    ? undefined
    : `${origin}/reset-password?token=${encodeURIComponent(token)}`
}

/** `/verify-email?token=` — finishes signup. */
export function buildVerificationLink(
  webAppUrl: string | undefined,
  token: string,
): string | undefined {
  const origin = webOrigin(webAppUrl)
  return origin === undefined
    ? undefined
    : `${origin}/verify-email?token=${encodeURIComponent(token)}`
}

/** Migrated-user reconnect link. A migrated account is
 * pre-provisioned with no password; the user sets one via the same
 * `/reset-password` set-password page and lands on their populated account. This
 * is the canonical builder the launch-wave caller reuses so it never
 * re-derives the WEB_APP_URL URL shape or builds a wrong-origin link. */
export function buildReconnectLink(
  webAppUrl: string | undefined,
  token: string,
): string | undefined {
  return buildResetLink(webAppUrl, token)
}

/** Public self-serve signup link for waitlist re-engagement.
 * No token — it points at the open `/signup` page; no account is provisioned. */
export function buildSignupLink(webAppUrl: string | undefined): string | undefined {
  const origin = webOrigin(webAppUrl)
  return origin === undefined ? undefined : `${origin}/signup`
}
