// SPDX-License-Identifier: Apache-2.0
// API-key lifecycle. The apps->core->db layer: REST routes call
// issueApiKey()/resolveApiKey() and stay thin; all DB access goes through the
// narrow packages/db api-key wrappers.
//
// Key scheme: `3ng_<prefix>_<secret>`.
//   - prefix: a short random PLAINTEXT identifier, stored in api_keys.prefix and
//     carried by the api_keys_prefix_idx — it makes a presented key cheaply
//     identifiable for support/listing WITHOUT exposing the secret.
//   - secret: 32 bytes of CSPRNG entropy, base64url-encoded.
// The SERVER STORES ONLY THE SHA-256 HASH OF THE FULL `3ng_<prefix>_<secret>`
// string (key_hash). The resolver compares opaque hashes, so core and the db
// wrapper MUST hash the identical input — the full string, not just the secret.
// The plaintext is returned to the caller exactly once at issuance and never
// persisted. A stolen DB therefore yields no usable keys. SHA-256 (not
// argon2id) is correct here: the input is high-entropy random, so there is no
// dictionary to defend against and the lookup must be a fast indexed equality.
//
// Never log the key, its hash, or the secret (hard rule 6).
import { createHash, randomBytes } from 'node:crypto'
import {
  type ApiKeyMetadata,
  insertApiKey,
  listApiKeys,
  resolveApiKey as resolveApiKeyHash,
  revokeApiKey,
  touchApiKeyLastUsed as touchApiKeyLastUsedHash,
} from '@3ngram/db'

const KEY_SCHEME_PREFIX = '3ng_'
const PREFIX_BYTES = 6
const SECRET_BYTES = 32

export type { ApiKeyMetadata }

/** A freshly issued key — the plaintext (returned once) plus its metadata. */
export interface IssuedApiKey {
  id: string
  key: string
  prefix: string
  name: string
  createdAt: Date
}

/** sha256(fullKey) hex — the only form of the key the DB ever sees. */
export function hashApiKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex')
}

/**
 * Issue a new API key for an already-authenticated user. Mints a random prefix
 * and secret, assembles `3ng_<prefix>_<secret>`, persists only its SHA-256 hash
 * (plus the plaintext prefix for indexed lookup), and returns the plaintext
 * ONCE. The caller must surface `key` to the user and then discard it.
 */
export async function issueApiKey(userId: string, name: string): Promise<IssuedApiKey> {
  const prefix = randomBytes(PREFIX_BYTES).toString('base64url')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const key = `${KEY_SCHEME_PREFIX}${prefix}_${secret}`
  const { id, createdAt } = await insertApiKey(userId, name, hashApiKey(key), prefix)
  return { id, key, prefix, name, createdAt }
}

/**
 * Resolve a presented API key to its owner's user id, or undefined when the key
 * is malformed, unknown, or revoked (the resolver filters revoked_at IS NULL).
 * The caller binds the id into the request context; the plaintext never leaves
 * here. A syntactically invalid key short-circuits to undefined so a malformed
 * key and an unknown key are indistinguishable to the caller (uniform 401).
 */
export async function authenticateApiKey(key: string): Promise<string | undefined> {
  if (!key.startsWith(KEY_SCHEME_PREFIX)) return undefined
  const resolved = await resolveApiKeyHash(hashApiKey(key))
  return resolved?.userId
}

/**
 * Best-effort stamp of last_used_at after a successful resolution. Hashes the
 * full key (same input as resolution) and delegates to the tenant-scoped db
 * wrapper. Callers invoke this fire-and-forget AFTER binding the identity; it
 * must never block the request and its rejection is the caller's to catch and
 * log redacted (hard rule 6).
 */
export async function touchApiKeyLastUsed(userId: string, key: string): Promise<void> {
  await touchApiKeyLastUsedHash(userId, hashApiKey(key))
}

export { listApiKeys, revokeApiKey }
