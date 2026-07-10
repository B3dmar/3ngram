// SPDX-License-Identifier: Apache-2.0
// Password-reset email delivery (self-host hardening). SMTP is OPTIONAL by design: a self-hosted 3ngram must boot and
// serve forgot-password with NO mail server configured. This module is the one
// place that decides "send vs degrade" so the transport (auth.ts) stays thin
// (hard rule 5) and never re-derives SMTP config.
//
// Degradation contract: when SMTP is not configured (loadSmtpConfig() returns
// undefined), sendResetEmail returns { delivered: false, reason: 'smtp-not-
// configured' } — it does NOT throw. The caller then falls back to the
// documented owner-level reset / dev-token path. A transport failure at send
// time is ALSO non-fatal here: it returns { delivered: false, reason: 'send-
// failed' } so the route can still answer a uniform 200 (no user enumeration) instead of leaking a 500 on a flaky MTA.
//
// Hard rule 6: SMTP_PASS and the recipient address never enter a log line — the
// mailer logs host/port and (on success) the transport message id only.
import { loadSmtpConfig, log, type SmtpConfig } from '@3ngram/config'
import { createTransport } from 'nodemailer'

/** The minimal transport surface the mailer needs — a seam for a mock in tests. */
export interface MailTransport {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
  }): Promise<{ messageId: string }>
}

/** Builds a transport from resolved SMTP config. Default: a nodemailer transport. */
export type TransportFactory = (config: SmtpConfig) => MailTransport

/** Outcome of an attempted reset-email send. `delivered: false` is never an error. */
export type SendResult =
  | { delivered: true; messageId: string }
  | { delivered: false; reason: 'smtp-not-configured' | 'send-failed' }

/** Dependencies the mailer resolves from env by default; overridable in tests. */
export interface MailerOptions {
  /** Resolve SMTP config (undefined ⇒ not configured). Defaults to loadSmtpConfig. */
  loadConfig?: () => SmtpConfig | undefined
  /** Build a transport from config. Defaults to the real nodemailer transport. */
  transportFactory?: TransportFactory
}

const RESET_SUBJECT = 'Reset your 3ngram password'
const VERIFY_SUBJECT = 'Verify your 3ngram email'
const MIGRATION_SUBJECT = 'Your 3ngram memory is ready'
const REENGAGEMENT_SUBJECT = 'Reconnect with 3ngram'

interface MailMessage {
  recipient: string
  subject: string
  text: string
  successLog: string
  failureLog: string
}

/** Build the nodemailer transport. `auth` is omitted for an unauthenticated relay. */
function defaultTransportFactory(config: SmtpConfig): MailTransport {
  return createTransport({
    host: config.host,
    port: config.port,
    // STARTTLS on the submission port (587); implicit TLS on 465.
    secure: config.port === 465,
    ...(config.auth ? { auth: config.auth } : {}),
  }) as unknown as MailTransport
}

/** The plaintext body — the reset link only, no PII beyond what the user gave us. */
function resetBody(resetLink: string): string {
  return [
    'A password reset was requested for your 3ngram account.',
    '',
    'Open this link to choose a new password:',
    resetLink,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n')
}

function verificationBody(verificationLink: string): string {
  return [
    'Verify this email address for your 3ngram account.',
    '',
    'Open this link to finish signup:',
    verificationLink,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n')
}

/** Migrated-user reconnect body. `reconnectLink` is the existing set-password /
 * reset link (built by the caller against WEB_APP_URL) pointing at the
 * pre-provisioned, already-populated account — "your memory moved with you". */
function migrationBody(reconnectLink: string): string {
  return [
    'Your memory has moved to 3ngram, and your full history came with you.',
    '',
    'Open this link to set your password and reconnect to your account:',
    reconnectLink,
    '',
    'After signing in, repoint your client to 3ngram (the dashboard has the connection details).',
  ].join('\n')
}

/** Re-engagement body for a prior waitlist signup: self-serve signup is now
 * open, so `signupLink` points at the public signup page — no account is
 * provisioned for them (distinct from the migrated-user reconnect flow). */
function reengagementBody(signupLink: string): string {
  return [
    '3ngram is now open, so you can create your account whenever you like.',
    '',
    'Sign up here:',
    signupLink,
    '',
    'If you are no longer interested, you can ignore this email.',
  ].join('\n')
}

/**
 * Send the password-reset email if SMTP is configured; otherwise degrade.
 *
 * Returns `{ delivered: false }` (never throws) in two non-fatal cases:
 * - SMTP not configured ⇒ reason 'smtp-not-configured' (the route falls back to
 *   the owner-level / dev-token path).
 * - transport rejects at send time ⇒ reason 'send-failed' (the route still
 *   answers a uniform 200 — no enumeration on a flaky MTA).
 *
 * `recipient` and `resetLink` are caller-supplied; this module logs neither.
 */
async function sendEmail(message: MailMessage, options: MailerOptions = {}): Promise<SendResult> {
  const loadConfig = options.loadConfig ?? loadSmtpConfig
  const config = loadConfig()
  if (config === undefined) {
    log().info('mailer: SMTP not configured, degrading to owner-level email path')
    return { delivered: false, reason: 'smtp-not-configured' }
  }
  const factory = options.transportFactory ?? defaultTransportFactory
  const transport = factory(config)
  try {
    const { messageId } = await transport.sendMail({
      from: config.from,
      to: message.recipient,
      subject: message.subject,
      text: message.text,
    })
    // host/port/message-id only — never the recipient or the link (hard rule 6).
    log().info({ smtpHost: config.host, smtpPort: config.port, messageId }, message.successLog)
    return { delivered: true, messageId }
  } catch {
    log().warn({ smtpHost: config.host, smtpPort: config.port }, message.failureLog)
    return { delivered: false, reason: 'send-failed' }
  }
}

export async function sendResetEmail(
  recipient: string,
  resetLink: string,
  options: MailerOptions = {},
): Promise<SendResult> {
  return sendEmail(
    {
      recipient,
      subject: RESET_SUBJECT,
      text: resetBody(resetLink),
      successLog: 'mailer: reset email sent',
      failureLog: 'mailer: reset email send failed, degrading',
    },
    options,
  )
}

export async function sendVerificationEmail(
  recipient: string,
  verificationLink: string,
  options: MailerOptions = {},
): Promise<SendResult> {
  return sendEmail(
    {
      recipient,
      subject: VERIFY_SUBJECT,
      text: verificationBody(verificationLink),
      successLog: 'mailer: verification email sent',
      failureLog: 'mailer: verification email send failed, degrading',
    },
    options,
  )
}

/**
 * Send the migrated-user reconnect email if SMTP is configured; otherwise
 * degrade (same contract as sendResetEmail — never throws). `reconnectLink` is
 * the existing set-password link the caller builds against WEB_APP_URL. Used by
 * the legacy-migration launch wave. Logs neither recipient
 * nor link (hard rule 6).
 */
export async function sendMigrationEmail(
  recipient: string,
  reconnectLink: string,
  options: MailerOptions = {},
): Promise<SendResult> {
  return sendEmail(
    {
      recipient,
      subject: MIGRATION_SUBJECT,
      text: migrationBody(reconnectLink),
      successLog: 'mailer: migration email sent',
      failureLog: 'mailer: migration email send failed, degrading',
    },
    options,
  )
}

/**
 * Send an arbitrary transactional email if SMTP is configured; otherwise degrade
 * (same never-throw contract as the named senders above). This is the generic
 * primitive a private surface reuses for its own notifications so the SMTP
 * transport, degrade-to-noop policy, and hard-rule-6 logging discipline all stay
 * in THIS one module — the private package never re-wires nodemailer. `logLabel`
 * MUST be a bounded, content-free tag; neither the recipient nor the body is ever
 * logged.
 */
export async function sendTransactionalEmail(
  recipient: string,
  subject: string,
  text: string,
  logLabel: string,
  options: MailerOptions = {},
): Promise<SendResult> {
  return sendEmail(
    {
      recipient,
      subject,
      text,
      successLog: `mailer: ${logLabel} email sent`,
      failureLog: `mailer: ${logLabel} email send failed, degrading`,
    },
    options,
  )
}

/**
 * Send a re-engagement email inviting a prior waitlist signup to self-serve
 * signup. `signupLink` is the public signup URL — this does
 * NOT provision an account. Same degrade-never-throw contract; logs neither
 * recipient nor link.
 */
export async function sendReengagementEmail(
  recipient: string,
  signupLink: string,
  options: MailerOptions = {},
): Promise<SendResult> {
  return sendEmail(
    {
      recipient,
      subject: REENGAGEMENT_SUBJECT,
      text: reengagementBody(signupLink),
      successLog: 'mailer: re-engagement email sent',
      failureLog: 'mailer: re-engagement email send failed, degrading',
    },
    options,
  )
}

/** True iff SMTP is configured — lets the route pick the delivery vs degraded copy. */
export function isMailerConfigured(
  loadConfig: () => SmtpConfig | undefined = loadSmtpConfig,
): boolean {
  return loadConfig() !== undefined
}
