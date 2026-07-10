// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * Scopes are user-defined strings, not a closed enum (docs/concepts/
 * data-model.mdx: scopes table with aliases). The schema constrains shape;
 * the defaults seed new accounts.
 */
export const scopeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case: lowercase alphanumerics and hyphens')
export type Scope = z.infer<typeof scopeSchema>

export const DEFAULT_SCOPES = ['personal', 'work'] as const
