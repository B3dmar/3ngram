// SPDX-License-Identifier: Apache-2.0
// Auth transport. Thin by contract: validate at the one
// boundary (loginInputSchema), delegate the credential check + session mint to
// packages/core, shape the HTTP response. No business logic here.
//
// Status contract: 400 only for a schema-invalid body; a uniform
// 401 for both wrong password and unknown user (no user enumeration); 200 with
// { token, expiresAt } on success. The token is returned once and never logged.
//
// RATE LIMIT: per-IP limiters run BEFORE each
// handler. The factory injects one limiter per public endpoint so each carries
// its own threshold (signup 5/min, resend 3/min, verify 10/min, forgot
// 3/min, reset 5/min) while login + change-password keep the shared `limiter`.
// Distinct buckets are config-driven in the app factory (no logic in routes)
// and exercised without Redis (the limiters are injectable seams).
import { loadEnv, log } from '@3ngram/config'
import type { LimitsResolver } from '@3ngram/core'
import {
  assertPasswordNotBreached,
  changePasswordAndRevokeOthers,
  EmailNotVerifiedError,
  InvalidCurrentPasswordError,
  InvalidEmailVerificationTokenError,
  InvalidResetTokenError,
  login,
  PasswordBreachedError,
  requestPasswordReset,
  requestSignup,
  resendEmailVerification,
  resetPassword,
  verifyEmail,
} from '@3ngram/core/auth'
import {
  changePasswordInputSchema,
  forgotPasswordInputSchema,
  loginInputSchema,
  resendVerificationInputSchema,
  resetPasswordInputSchema,
  signupInputSchema,
  verifyEmailInputSchema,
} from '@3ngram/schema'
import { type NextFunction, type Request, type Response, Router } from 'express'
import { buildResetLink, buildVerificationLink } from '../links.js'
import { sendResetEmail, sendVerificationEmail } from '../mailer.js'
import { authenticate, readBearerToken } from '../middleware/authenticate.js'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'

/**
 * Per-IP limiters the boot wiring injects. `limiter` is the
 * shared bucket guarding /auth/login + /auth/change-password (the established
 * per-IP rate-limit surface). The five public self-serve endpoints each get their own
 * bucket so the thresholds can differ per endpoint; when a per-endpoint
 * limiter is omitted it falls back to the shared `limiter` (keeps tests that
 * inject only `limiter` working and gives a safe default if boot under-wires).
 */
export interface AuthRouterOptions {
  limiter: RateLimiterMiddleware
  signupLimiter?: RateLimiterMiddleware
  resendVerificationLimiter?: RateLimiterMiddleware
  verifyEmailLimiter?: RateLimiterMiddleware
  forgotPasswordLimiter?: RateLimiterMiddleware
  resetPasswordLimiter?: RateLimiterMiddleware
  /** Billing-neutral resource-limit resolver used by welcome provisioning. */
  limits?: LimitsResolver | undefined
}

/**
 * Turn a freshly minted verification token into a delivered email. No token
 * (unknown / already-verified account) or no WEB_APP_URL (no web origin to link
 * to) ⇒ no send. The send is fire-and-forget after the neutral 202; the mailer
 * degrades and never throws, so this guard only stops an unexpected rejection
 * from crashing the process. The token is a credential — never logged.
 */
function deliverVerificationEmail(
  webAppUrl: string | undefined,
  email: string,
  token: string | undefined,
): void {
  if (token === undefined) return
  const verificationLink = buildVerificationLink(webAppUrl, token)
  if (verificationLink === undefined) return
  void sendVerificationEmail(email, verificationLink).catch(() => {})
}

/** Build the /auth router with per-IP rate limiters gating each endpoint. */
export function authRouter(options: AuthRouterOptions): Router {
  const router = Router()

  // Per-endpoint buckets, each falling back to the shared login limiter
  // when boot does not inject a dedicated one (tests inject only `limiter`).
  const signupLimiter = options.signupLimiter ?? options.limiter
  const resendVerificationLimiter = options.resendVerificationLimiter ?? options.limiter
  const verifyEmailLimiter = options.verifyEmailLimiter ?? options.limiter
  const forgotPasswordLimiter = options.forgotPasswordLimiter ?? options.limiter
  const resetPasswordLimiter = options.resetPasswordLimiter ?? options.limiter

  router.post('/auth/login', options.limiter, (req, res, next) => {
    const parsed = loginInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const { email, password } = parsed.data
    login(email, password, loadEnv().SESSION_TTL_HOURS)
      .then((grant) => {
        if (grant === undefined) {
          res.status(401).json({ error: 'invalid_credentials' })
          return
        }
        res.status(200).json({ token: grant.token, expiresAt: grant.expiresAt.toISOString() })
      })
      .catch((error: unknown) => {
        if (error instanceof EmailNotVerifiedError) {
          res.status(403).json({ error: 'email_not_verified' })
          return
        }
        next(error)
      })
  })

  // POST /auth/signup — public account creation, feature-gated and email-
  // verification first. The response is neutral for new, unverified duplicate,
  // and verified duplicate emails; actual creation + delivery runs after the
  // 202 so timing cannot enumerate accounts. AUTH_SIGNUP_ENABLED=true requires
  // SMTP + WEB_APP_URL at env load, so enabled deploys have a delivery path.
  router.post('/auth/signup', signupLimiter, (req, res, next) => {
    const parsed = signupInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const env = loadEnv()
    if (!env.AUTH_SIGNUP_ENABLED) {
      res.status(403).json({ error: 'signup_disabled' })
      return
    }
    const { email, password, clientProofHash } = parsed.data
    const deliver = (token: string | undefined): void =>
      deliverVerificationEmail(env.WEB_APP_URL, email, token)

    // Breach-screen the password BEFORE the neutral 202 (research R3). The verdict
    // depends on the password alone — identical for any email — so AWAITING it is
    // not an enumeration oracle, unlike the account-existence work below which
    // stays fire-and-forget off the response path. The check fails open, so a
    // breached password is the only non-202 outcome here.
    assertPasswordNotBreached(password, {
      enabled: env.PASSWORD_BREACH_CHECK_ENABLED,
      logger: log(),
    })
      .then(() => {
        res.status(202).json({ status: 'verification_sent' })
        void requestSignup(
          email,
          password,
          clientProofHash,
          env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES,
        )
          .then(deliver)
          .catch(() => {
            // No account signal reaches the requester after the neutral 202.
            // Avoid logging email/password/token material (hard rule 6).
          })
      })
      .catch((error: unknown) => {
        if (error instanceof PasswordBreachedError) {
          res.status(400).json({ error: 'password_breached' })
          return
        }
        next(error)
      })
  })

  // POST /auth/verify-email — consumes a signup verification token and returns
  // the same session grant shape as login so the web BFF can set its httpOnly
  // cookie and land the user in onboarding.
  router.post('/auth/verify-email', verifyEmailLimiter, (req, res, next) => {
    const parsed = verifyEmailInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    verifyEmail(parsed.data.token, parsed.data.clientProof, loadEnv().SESSION_TTL_HOURS, {
      limits: options.limits,
    })
      .then((grant) => {
        res.status(200).json({ token: grant.token, expiresAt: grant.expiresAt.toISOString() })
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidEmailVerificationTokenError) {
          res.status(401).json({ error: 'invalid_token' })
          return
        }
        next(error)
      })
  })

  // POST /auth/resend-verification — mint a FRESH verification link for
  // an unverified account, superseding any prior one. Same per-IP limiter and the
  // same feature gate as signup (an enabled deploy is guaranteed a delivery path).
  // Enumeration-resistant exactly like signup: respond a neutral 202 FIRST, then
  // run the email lookup + supersede-mint + send fire-and-forget OFF the response
  // path, so an unknown, an already-verified, and an unverified email are
  // indistinguishable in status, body, AND latency. The new link is bound to the
  // caller-held client proof. Token/email are never logged.
  router.post('/auth/resend-verification', resendVerificationLimiter, (req, res) => {
    const parsed = resendVerificationInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const env = loadEnv()
    if (!env.AUTH_SIGNUP_ENABLED) {
      res.status(403).json({ error: 'signup_disabled' })
      return
    }
    const { email, clientProofHash } = parsed.data

    res.status(202).json({ status: 'verification_sent' })
    void resendEmailVerification(email, clientProofHash, env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES)
      .then((token) => deliverVerificationEmail(env.WEB_APP_URL, email, token))
      .catch(() => {
        // No account signal reaches the requester after the neutral 202; the
        // mint/send error is swallowed (it must not enumerate) and nothing is
        // logged (hard rule 6) — this guard only stops a deferred reject crashing.
      })
  })

  // POST /auth/change-password — authenticated rotation that
  // ALSO revokes every other live session, keeping the current one. Order of
  // gates: the SAME per-IP limiter that guards /auth/login runs FIRST (it caps
  // brute-force on currentPassword from one source before any work happens),
  // then authenticate binds req.userId. Thin transport: validate at
  // the one boundary, hand core the plaintext bearer token (so core hashes it
  // privately and revokes the OTHER sessions) plus both passwords, shape the
  // response. Status contract: 204 on success (no body), 400 for a schema-invalid
  // body, 403 for a wrong current password (InvalidCurrentPasswordError). The 403
  // is deliberately DISTINCT from the authenticate middleware's 401 (invalid/
  // expired session): the session is valid here, only the supplied current
  // password is wrong, so the web action can redirect a stale session (401) yet
  // show an inline error for a wrong password (403). No enumeration concern —
  // this is the logged-in user rotating their own password. Neither
  // password nor the token is ever logged.
  router.post(
    '/auth/change-password',
    options.limiter,
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      const parsed = changePasswordInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      // authenticate guarantees req.userId is bound and a well-formed Bearer
      // token was present before this handler runs; re-read the plaintext token
      // (authenticate.ts:55 pattern) so core can revoke the OTHER sessions while
      // preserving this one.
      const userId = req.userId as string
      const currentToken = readBearerToken(req.header('authorization')) as string
      const { currentPassword, newPassword } = parsed.data
      changePasswordAndRevokeOthers(userId, currentPassword, newPassword, currentToken)
        .then(() => {
          res.status(204).end()
        })
        .catch((error: unknown) => {
          if (error instanceof InvalidCurrentPasswordError) {
            res.status(403).json({ error: 'invalid_credentials' })
            return
          }
          next(error)
        })
    },
  )

  // POST /auth/forgot-password — request a reset link. The SAME
  // per-IP limiter guards it (it mints a credential + does an argon2-free DB
  // write per call). Thin transport: validate the email at the one
  // boundary, hand core the email + TTL, ALWAYS respond 200 — whether or not the
  // account exists (no enumeration, matching the login/change-password 401
  // uniformity). The ONLY non-200 here is a 400 for a syntactically invalid
  // email. core returns the freshly minted plaintext token for a KNOWN account
  // (undefined otherwise); it is surfaced in the body ONLY when
  // AUTH_RESET_TOKEN_DEV_ECHO is set, which the env layer refuses outside
  // NODE_ENV=development. The token is a credential: it is NEVER logged,
  // in dev or prod.
  //
  // DELIVERY: when an account matches, the plaintext token is
  // turned into a reset link (against WEB_APP_URL — the dashboard origin that
  // serves /reset-password, NOT the API's BASE_URL) and handed to the SMTP-
  // optional mailer. SMTP is OPTIONAL — sendResetEmail degrades silently (never
  // throws) when SMTP is off or the MTA is flaky, so self-host still boots and the
  // dev-token path stays available.
  //
  // TIMING (no user enumeration): the MINT itself leaks. A KNOWN account does
  // getUserByEmail + token generate + an INSERT (unique-index work); an UNKNOWN
  // account returns right after getUserByEmail. So awaiting requestPasswordReset()
  // before the 200 makes HTTP latency an enumeration oracle — known accounts
  // respond measurably slower despite an identical status/body. In PROD we
  // therefore respond the uniform 200 FIRST, then fire-and-forget the WHOLE
  // mint+insert+send chain off the critical path; every error is swallowed (the
  // response is already committed) so a deferred reject can never crash the
  // process. Known vs unknown then respond with identical body, status, AND
  // timing. The DEV-ECHO path (NODE_ENV=development + AUTH_RESET_TOKEN_DEV_ECHO)
  // still AWAITS so it can return the minted token in the body — timing is
  // irrelevant in dev.
  router.post('/auth/forgot-password', forgotPasswordLimiter, (req, res, next) => {
    const parsed = forgotPasswordInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const env = loadEnv()
    const { email } = parsed.data

    // Turn a freshly minted token into a delivered reset email. WEB_APP_URL unset
    // (no dashboard origin to link to) or no token (unknown account) ⇒ no send.
    const deliver = (token: string | undefined): void => {
      if (token === undefined) return
      const resetLink = buildResetLink(env.WEB_APP_URL, token)
      if (resetLink === undefined) return
      void sendResetEmail(email, resetLink).catch(() => {
        // Swallow: the 200 is already committed and the mailer's own contract
        // never throws; this guard only covers an unexpected rejection so a
        // deferred send can never crash the process.
      })
    }

    // DEV-ECHO: await the mint so the plaintext token can be returned in the body.
    // Only reachable with NODE_ENV=development (env superRefine), so the timing
    // oracle does not matter and the token is allowed in the response.
    if (env.AUTH_RESET_TOKEN_DEV_ECHO) {
      requestPasswordReset(email, env.RESET_TOKEN_TTL_MINUTES)
        .then((token) => {
          deliver(token)
          if (token !== undefined) {
            res.status(200).json({ status: 'ok', resetToken: token })
            return
          }
          res.status(200).json({ status: 'ok' })
        })
        .catch(next)
      return
    }

    // PROD: respond the uniform 200 FIRST, then run the entire mint+insert+send
    // chain fire-and-forget OFF the response path (see TIMING above) so a known
    // and an unknown account are indistinguishable in body, status, AND latency.
    res.status(200).json({ status: 'ok' })
    void requestPasswordReset(email, env.RESET_TOKEN_TTL_MINUTES)
      .then(deliver)
      .catch(() => {
        // Swallow: the 200 is already committed. The mint/insert error is not
        // surfaced (it must not enumerate the account) and the token is NEVER
        // logged (hard rule 6); this guard only stops a deferred reject from
        // crashing the process.
      })
  })

  // POST /auth/reset-password — consume a reset token, set the new
  // password, and revoke EVERY session the user holds (a forgotten-password reset
  // implies the account may be compromised). SAME per-IP limiter. Thin transport:
  // validate the token + new password at the one boundary, delegate to core,
  // shape the response. Status contract: 204 on success (no body), 400 for a
  // schema-invalid body, 401 for any token that fails to reset — unknown,
  // expired, already-consumed, OR a token that lost a concurrent reset race
  // (InvalidResetTokenError — a single uniform failure, no enumeration of which
  // tokens ever existed). Hard rule 6: the token and the new password are never
  // logged.
  router.post('/auth/reset-password', resetPasswordLimiter, (req, res, next) => {
    const parsed = resetPasswordInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const { token, newPassword } = parsed.data
    resetPassword(token, newPassword, {
      enabled: loadEnv().PASSWORD_BREACH_CHECK_ENABLED,
      logger: log(),
    })
      .then(() => {
        res.status(204).end()
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidResetTokenError) {
          res.status(401).json({ error: 'invalid_token' })
          return
        }
        if (error instanceof PasswordBreachedError) {
          res.status(400).json({ error: 'password_breached' })
          return
        }
        next(error)
      })
  })

  return router
}
