// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * Onboarding "About you" profiling. A short, OPTIONAL
 * survey captured at first run so the team can see who signs up. This is the
 * single validation boundary (hard rule 2): the server validates the PUT body
 * against `userProfileAttributesSchema`, and the DB CHECK constraints are
 * generated from these same enum `.options` (helpers.enumCheckSql), so the
 * column domain can never drift from the Zod source.
 *
 * Every field is optional — the user may answer some, all, or none, and a skip
 * persists nothing. No free text / PII: each answer is a closed enum slug.
 */

export const profileRoleSchema = z.enum(['engineer', 'founder', 'product', 'researcher', 'other'])
export type ProfileRole = z.infer<typeof profileRoleSchema>

export const profileUseCaseSchema = z.enum(['personal', 'team', 'dev', 'research', 'other'])
export type ProfileUseCase = z.infer<typeof profileUseCaseSchema>

export const profileAiToolSchema = z.enum(['claude', 'chatgpt', 'cursor', 'codex', 'other'])
export type ProfileAiTool = z.infer<typeof profileAiToolSchema>

export const profileReferralSourceSchema = z.enum([
  'reddit',
  'twitter',
  'colleague',
  'search',
  'other',
])
export type ProfileReferralSource = z.infer<typeof profileReferralSourceSchema>

/** The PUT /auth/profile body. All fields optional; an absent field clears nothing. */
export const userProfileAttributesSchema = z.object({
  role: profileRoleSchema.optional(),
  useCase: profileUseCaseSchema.optional(),
  aiTools: z.array(profileAiToolSchema).max(8).optional(),
  referralSource: profileReferralSourceSchema.optional(),
})
export type UserProfileAttributes = z.infer<typeof userProfileAttributesSchema>
