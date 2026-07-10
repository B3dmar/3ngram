// SPDX-License-Identifier: Apache-2.0
// Onboarding connection status.
// The apps->core->db layer: the thin GET /auth/onboarding route calls this and
// shapes the HTTP body; the "has the user connected an agent yet" decision lives
// here, the oauth_tokens existence check goes through the narrow packages/db
// wrapper (userHasOauthToken, RLS-scoped via withTenant).
//
// "Connected" = the user has been issued their FIRST OAuth token (an MCP client
// completed DCR + the authorization-code exchange under their session).
// A once-issued token is a durable signal even if later revoked/expired, so the
// onboarding step flips to "Connected ✓" and stays flipped — it answers "did
// they ever connect an agent", which is the activation moment we detect, not
// "is a grant live right now" (that is the consent/grant-management surface).
//
// Observability (hard rule 6): a boolean only — no token, hash, or client id.
import { userHasOauthToken } from '@3ngram/db'

/** The onboarding connection signal the dashboard polls. */
export interface OnboardingStatus {
  /** True once the user has been issued their first OAuth token (first agent connection). */
  connected: boolean
}

/**
 * Read the caller's onboarding connection status: connected iff they have ever
 * been issued an OAuth token. RLS-scoped to the caller in the db layer, so this
 * can only ever report the caller's own state.
 */
export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  return { connected: await userHasOauthToken(userId) }
}
