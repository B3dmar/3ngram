#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// OAuth signing-key rotation ("a scripts/rotate-oauth-key
// task ships with v1 — rotation untested is rotation broken").
//
// Generates a fresh RS256 keypair as a private JWK with a new `kid`, prepends it
// to the EXISTING OAUTH_JWKS array (read from the env), and prints the updated
// JSON array to stdout. The new key becomes the current signing key (first in
// the array); the old keys stay for verification until their issued tokens
// expire, then a later run drops the tail.
//
// Usage:
//   OAUTH_JWKS='[...]' node scripts/rotate-oauth-key.mjs   # rotate existing set
//   node scripts/rotate-oauth-key.mjs                      # bootstrap first key
//
// Copy the printed array into OAUTH_JWKS (Railway/compose env). The private key
// material is printed to stdout only — never logged, never committed.
//
// The array-merge semantics (new key to the front, keep the rest) mirror the
// unit-tested `rotateKeyArray` in packages/core/src/auth/oauth.ts.
import { randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair } from 'jose'

const ALG = 'RS256'

async function generateSigningKey() {
  const { privateKey } = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true })
  const jwk = await exportJWK(privateKey)
  return { ...jwk, kid: randomUUID(), alg: ALG, use: 'sig' }
}

function readExistingKeys() {
  const raw = process.env.OAUTH_JWKS
  if (raw === undefined || raw.trim() === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('OAUTH_JWKS is set but is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('OAUTH_JWKS must be a JSON array')
  return parsed
}

async function main() {
  const existing = readExistingKeys()
  const newKey = await generateSigningKey()
  const rotated = [newKey, ...existing]
  // Pretty-print for human copy; the env value can be minified.
  process.stdout.write(`${JSON.stringify(rotated, null, 2)}\n`)
  process.stderr.write(
    `Rotated: new kid ${newKey.kid} is now current; ${existing.length} old key(s) retained for verification.\n`,
  )
}

main().catch((err) => {
  process.stderr.write(
    `rotate-oauth-key failed: ${err instanceof Error ? err.message : 'unknown'}\n`,
  )
  process.exit(1)
})
