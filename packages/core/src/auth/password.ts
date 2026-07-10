// SPDX-License-Identifier: Apache-2.0
// Password hashing — argon2id only. The output is a
// self-describing PHC string ($argon2id$v=19$m=...,t=...,p=...$salt$hash) so
// parameters travel with the hash and can be tuned without a migration.
//
// Never log the plaintext, the hash, or the email at this layer — IDs/lengths
// only (AGENTS.md hard rule 6; docs/concepts/observability.mdx §1).

import type { Algorithm } from '@node-rs/argon2'
import { hash, verify } from '@node-rs/argon2'

// `Algorithm` is an ambient const enum; verbatimModuleSyntax forbids reading
// its members as values, so we pin the variant by its stable numeric id.
// (Algorithm.Argon2id === 2 — asserted in the unit tests by the $argon2id$
// hash prefix.)
const ARGON2ID: Algorithm = 2

// OWASP-aligned argon2id parameters (memory in KiB). Deliberately explicit so
// a future tuning is a reviewed change, not an implicit dependency default.
const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

/** Hash a plaintext password into a PHC-format argon2id string. */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, HASH_OPTIONS)
}

/**
 * Verify a plaintext password against a stored PHC hash. Returns false on
 * mismatch; a malformed hash throws (it is a data-integrity bug, not a
 * routine wrong-password path).
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  return verify(storedHash, plaintext)
}
