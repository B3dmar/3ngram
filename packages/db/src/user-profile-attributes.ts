// SPDX-License-Identifier: Apache-2.0
// Onboarding "About you" profiling store. One optional row
// per user; RLS scopes every access to the caller (hard rule 3) via withTenant.
// Drizzle only — no raw pool/client access (no-raw-db.grit). The PUT body is
// validated upstream against @3ngram/schema's userProfileAttributesSchema (the
// single validation boundary); this layer only persists/reads the typed shape.
import type { UserProfileAttributes } from '@3ngram/schema'
import { eq, sql } from 'drizzle-orm'
import { withTenant } from './client.js'
import { userProfileAttributes } from './schema/identity.js'

/** Read the caller's profile attributes, or null if they never answered. RLS-scoped. */
export async function getUserProfileAttributes(
  userId: string,
): Promise<UserProfileAttributes | null> {
  return withTenant(userId, async (tx) => {
    const [row] = await tx
      .select({
        role: userProfileAttributes.role,
        useCase: userProfileAttributes.useCase,
        aiTools: userProfileAttributes.aiTools,
        referralSource: userProfileAttributes.referralSource,
      })
      .from(userProfileAttributes)
      .where(eq(userProfileAttributes.userId, userId))
      .limit(1)
    if (!row) return null
    return {
      role: row.role ?? undefined,
      useCase: row.useCase ?? undefined,
      aiTools: row.aiTools ?? undefined,
      referralSource: row.referralSource ?? undefined,
    } as UserProfileAttributes
  })
}

/** Upsert the caller's profile attributes (one row per user, keyed on user_id). RLS-scoped. */
export async function upsertUserProfileAttributes(
  userId: string,
  attrs: UserProfileAttributes,
): Promise<void> {
  // Only write the fields the caller actually provided: a partial body like
  // { role } must NOT clear previously saved useCase/aiTools/referralSource
  // (the schema contract: an absent field clears nothing).
  const provided = {
    ...(attrs.role !== undefined ? { role: attrs.role } : {}),
    ...(attrs.useCase !== undefined ? { useCase: attrs.useCase } : {}),
    ...(attrs.aiTools !== undefined ? { aiTools: attrs.aiTools } : {}),
    ...(attrs.referralSource !== undefined ? { referralSource: attrs.referralSource } : {}),
  }
  await withTenant(userId, async (tx) => {
    await tx
      .insert(userProfileAttributes)
      .values({ userId, ...provided })
      .onConflictDoUpdate({
        target: userProfileAttributes.userId,
        set: { ...provided, updatedAt: sql`now()` },
      })
  })
}
