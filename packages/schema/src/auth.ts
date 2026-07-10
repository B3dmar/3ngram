// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * OAuth client authentication methods the AS supports (client matrix: Claude = client_secret_post, ChatGPT/Cursor
 * = none; basic supported via the body shim since it is the RFC 7591 default).
 */
export const tokenEndpointAuthMethodSchema = z.enum([
  'none',
  'client_secret_post',
  'client_secret_basic',
])
export type TokenEndpointAuthMethod = z.infer<typeof tokenEndpointAuthMethodSchema>

/**
 * Credentials for user provisioning and public signup.
 * The single validation boundary for the email+password pair: `packages/core`
 * consumes this for operator-created users and the self-serve signup flow. The
 * password floor is a deliberate minimum, not a strength meter — argon2id
 * absorbs the rest at hash time.
 */
export const userCredentialsSchema = z.object({
  email: z.email().max(254).toLowerCase(),
  password: z.string().min(12).max(1024),
})
export type UserCredentials = z.infer<typeof userCredentialsSchema>

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * Authenticated change-password body (POST /auth/change-password) — the single
 * validation boundary for the change (hard rule 2). `currentPassword` is held to
 * the login floor (min 1): it only needs to be re-checkable against the stored
 * hash, and a wrong value is a uniform 401, never a 400 (no length-hint leak).
 * `newPassword` carries the provisioning floor (min 12) so a logged-in user can
 * never downgrade below userCredentialsSchema's strength minimum.
 */
export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
})
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>

/**
 * Public signup request body (POST /auth/signup). The requester proves
 * continuity between the password-setting browser and the email-verification
 * click with a client-held random secret; the API stores only its SHA-256 hash.
 */
export const signupInputSchema = userCredentialsSchema.extend({
  clientProofHash: sha256HexSchema,
})
export type SignupInput = z.infer<typeof signupInputSchema>

/**
 * Resend-verification request body (POST /auth/resend-verification). The
 * single validation boundary for the resend: an email to look up the unverified
 * account and a fresh client-proof hash to bind the new link to the requesting
 * browser. Mirrors the signup email shape (≤254, lowercased) so a resend and a
 * signup validate identically; the route ALWAYS responds with a neutral 202
 * (unknown / already-verified emails are indistinguishable — no enumeration).
 */
export const resendVerificationInputSchema = z.object({
  email: z.email().max(254).toLowerCase(),
  clientProofHash: sha256HexSchema,
})
export type ResendVerificationInput = z.infer<typeof resendVerificationInputSchema>

/**
 * Email verification request body (POST /auth/verify-email). The token is the
 * base64url plaintext sent in the email; clientProof is the browser-held secret
 * minted at signup. core hashes both before DB lookup.
 */
export const verifyEmailInputSchema = z.object({
  token: z.string().min(1).max(1024),
  clientProof: z.string().min(1).max(1024),
})
export type VerifyEmailInput = z.infer<typeof verifyEmailInputSchema>

/**
 * Forgot-password request body (POST /auth/forgot-password) — the
 * single validation boundary for the email (hard rule 2). Only an email is
 * required: the handler resolves it to an account and ALWAYS responds 200,
 * whether or not the account exists (no enumeration), so a syntactically invalid
 * email is the ONLY 400. Mirrors loginInputSchema's email shape exactly (≤ 254,
 * lowercased) so a reset request and a login request validate identically.
 */
export const forgotPasswordInputSchema = z.object({
  email: z.email().max(254).toLowerCase(),
})
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>

/**
 * Reset-password request body (POST /auth/reset-password) — the
 * single validation boundary for the token + new password (hard rule 2). `token`
 * is the base64url plaintext minted by core (32 random bytes ⇒ 43 base64url
 * chars); it is bounded but never strength-checked here — an unknown/expired/
 * consumed token is a uniform failure from core, never a 400. `newPassword`
 * carries the provisioning floor (min 12) so a reset can never set a password
 * weaker than userCredentialsSchema's minimum.
 */
export const resetPasswordInputSchema = z.object({
  token: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
})
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>

/**
 * Login request body (POST /auth/login) — the single validation boundary for
 * the credential pair (hard rule 2). Deliberately laxer than
 * userCredentialsSchema: a login attempt only needs a syntactically plausible
 * email and a non-empty password. The strength floor belongs at provisioning,
 * not at the door — re-imposing min(12) here would 400 a legitimately weak
 * legacy password and leak a hint that no min(12)-length account can exist.
 * Wrong credentials always yield a uniform 401, never a 400.
 */
export const loginInputSchema = z.object({
  email: z.email().max(254).toLowerCase(),
  password: z.string().min(1).max(1024),
})
export type LoginInput = z.infer<typeof loginInputSchema>

/**
 * Issue an API key (POST /auth/api-keys) — the single validation boundary for
 * the request body (hard rule 2). `name` is REQUIRED: the api_keys.name column
 * is NOT NULL, so a label is mandatory at issuance and echoed back as metadata
 * on list. It is a human-facing identifier only, never a secret.
 */
export const issueApiKeyInputSchema = z.object({
  name: z.string().min(1).max(255),
})
export type IssueApiKeyInput = z.infer<typeof issueApiKeyInputSchema>

/**
 * Redirect-URI policy for RFC 7591 registration:
 * https is required everywhere except the RFC 8252 loopback hosts
 * (http://localhost / http://127.0.0.1, any port — the hostname pattern never
 * sees the port), and a fragment is banned outright (RFC 6749 §3.1.2 — a `#`
 * anywhere in an absolute URI starts one). z.url() validates WITHOUT
 * transforming, so URIs are stored EXACTLY as presented — no normalization —
 * and the authorize endpoint can byte-equality match a presented
 * redirect_uri against the registered list.
 */
const redirectUriSchema = z
  .union([
    z.url({ protocol: /^https$/ }).max(2048),
    z.url({ protocol: /^http$/, hostname: /^(localhost|127\.0\.0\.1)$/ }).max(2048),
  ])
  .refine((value) => !value.includes('#'), {
    message: 'redirect_uri must not contain a fragment',
  })

/**
 * RFC 7591 dynamic client registration request (POST /oauth/register) — the
 * single validation boundary for the DCR shape (hard rule 2). It pre-empts the
 * 0005 DB CHECKs: the auth-method enum here makes oauth_clients_auth_method_check
 * unreachable, and core derives the secret from the validated method so the
 * secret-consistency CHECK holds by construction — a violation surfaces as this
 * schema's 400, never a raw pg CHECK failure. token_endpoint_auth_method
 * defaults to client_secret_basic, the RFC 7591 §2 default. Unknown RFC 7591
 * members (grant_types, scope, ...) are stripped, not rejected — v1 supports
 * authorization_code + PKCE only.
 */
export const clientRegistrationInputSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1).max(16),
  token_endpoint_auth_method: tokenEndpointAuthMethodSchema.default('client_secret_basic'),
  client_name: z.string().min(1).max(255).optional(),
})
export type ClientRegistrationInput = z.infer<typeof clientRegistrationInputSchema>

/**
 * OAuth scope parameter (RFC 6749 §3.3): space-delimited, case-sensitive. v1
 * issues exactly two scopes (the literals mirror core's
 * MEMORY_READ_SCOPE/MEMORY_WRITE_SCOPE; schema cannot import core by layering),
 * so any other token is rejected at this one boundary rather than minted into
 * a grant the RS would have to second-guess.
 */
const oauthScopeStringSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.split(' ').every((s) => s === 'memory:read' || s === 'memory:write'), {
    message: 'scope must be a space-delimited subset of memory:read memory:write',
  })

/** RFC 7636 §4: code_challenge (S256) and code_verifier are 43–128 unreserved chars. */
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

/**
 * GET /oauth/authorize query (OAuth AS) — the single
 * validation boundary for the authorization request shape (hard rule 2).
 * authorization_code + PKCE S256 is the ONLY supported flow, so
 * response_type/code_challenge_method are literals — anything else is a 400
 * before any redirect can be issued. redirect_uri is matched byte-exact against
 * the registered list in core (policy, not shape — it needs the stored client).
 */
export const authorizeRequestSchema = z.object({
  client_id: z.string().min(1).max(255),
  redirect_uri: z.string().min(1).max(2048).optional(),
  response_type: z.literal('code'),
  code_challenge: z.string().regex(PKCE_CHALLENGE_PATTERN),
  code_challenge_method: z.literal('S256'),
  scope: oauthScopeStringSchema.optional(),
  state: z.string().min(1).max(512).optional(),
  resource: z.url().max(2048).optional(),
})
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>

/**
 * POST /oauth/authorize body — the combined credentials + consent submission
 * (one form, no separate session infra). The OAuth
 * params ride along as hidden fields and are re-validated here; the credential
 * pair mirrors loginInputSchema's deliberate laxness (wrong creds are a 401,
 * never a 400); csrf_token pairs with the same-site cookie.
 */
export const consentSubmissionSchema = authorizeRequestSchema.extend({
  email: z.email().max(254).toLowerCase(),
  password: z.string().min(1).max(1024),
  csrf_token: z.string().min(1).max(256),
  // RFC 6749 §4.1.3: GET-time supplied-ness of redirect_uri, carried
  // as a distinct hidden field. The redirect_uri field is ALWAYS present in the
  // POST (the consent form embeds the RESOLVED URI), so presence there can't tell
  // supplied-from-resolved apart — this flag, minted at /authorize, can. '1' when
  // the client supplied redirect_uri; absent/anything else means resolved.
  redirect_uri_was_supplied: z.literal('1').optional(),
})
export type ConsentSubmission = z.infer<typeof consentSubmissionSchema>

/**
 * POST /oauth/token body (urlencoded) — the single validation boundary for the
 * token request shape (hard rule 2). Discriminated on grant_type: the two
 * supported grants only (the route maps an unknown grant_type to
 * unsupported_grant_type before parsing). client_secret may arrive in the body
 * (client_secret_post) or via the Basic-auth shim (S4: SDK 1.29 client auth
 * reads the body only); public clients omit it and are held to PKCE instead.
 * code_verifier is REQUIRED on the code grant — PKCE is mandatory for every
 * client, public or confidential.
 */
const tokenClientAuthShape = {
  client_id: z.string().min(1).max(255),
  client_secret: z.string().min(1).max(1024).optional(),
}
export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(512),
    code_verifier: z.string().regex(PKCE_CHALLENGE_PATTERN),
    redirect_uri: z.string().min(1).max(2048).optional(),
    resource: z.url().max(2048).optional(),
    ...tokenClientAuthShape,
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(512),
    scope: oauthScopeStringSchema.optional(),
    resource: z.url().max(2048).optional(),
    ...tokenClientAuthShape,
  }),
])
export type TokenRequest = z.infer<typeof tokenRequestSchema>

/**
 * Path-param validation for DELETE /auth/api-keys/:id — the single validation
 * boundary for the revoke target (hard rule 2). The api_keys.id column is a
 * uuid; a non-uuid param can never match a stored row, so the route treats a
 * parse failure as an unknown id (404) instead of forwarding it to the DB,
 * where the uuid cast would raise a 500 (the 404-on-unknown contract).
 */
export const apiKeyIdSchema = z.uuid()
export type ApiKeyId = z.infer<typeof apiKeyIdSchema>

/**
 * Path-param validation for DELETE /auth/oauth-clients/:clientId — the single
 * validation boundary for the grant-revoke target (hard rule 2).
 * client_id is a minted UUID (core registerOAuthClient), so a non-uuid param can
 * never match a stored grant; the route treats a parse failure as no-live-grant
 * (204, the same idempotent outcome as an unknown/already-revoked grant) so a
 * malformed id never reaches the DB.
 */
export const oauthClientIdParamSchema = z.uuid()
export type OAuthClientIdParam = z.infer<typeof oauthClientIdParamSchema>
