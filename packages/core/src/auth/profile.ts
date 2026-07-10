// SPDX-License-Identifier: Apache-2.0
// Onboarding "About you" profiling. Thin core surface over
// the RLS-scoped db store, keeping apps/* off @3ngram/db directly (layering hard
// rule 5). The body is validated at the transport boundary against
// userProfileAttributesSchema; this layer just reads/persists the typed shape.
import { getUserProfileAttributes, upsertUserProfileAttributes } from '@3ngram/db'
import type { UserProfileAttributes } from '@3ngram/schema'

/** The caller's onboarding profile attributes, or null if never answered. */
export function getUserProfile(userId: string): Promise<UserProfileAttributes | null> {
  return getUserProfileAttributes(userId)
}

/** Persist the caller's onboarding profile attributes (idempotent upsert). */
export function setUserProfile(userId: string, attrs: UserProfileAttributes): Promise<void> {
  return upsertUserProfileAttributes(userId, attrs)
}
