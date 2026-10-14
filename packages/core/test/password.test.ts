// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. argon2id round-trip and wrong-password rejection.
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

const PASSWORD = 'correct-horse-battery'

// Minted by @node-rs/argon2 2.0.2 (RustCrypto backend) with HASH_OPTIONS. Stored
// hashes outlive library upgrades, so a backend change must keep verifying them.
const LEGACY_PASSWORD = 'fixed-hash-regression-password'
const LEGACY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$7Jqi2bXnCSIv+lM/SfCPwQ$Oy2mV5XWmXWBrrr/6qX4qPaxg+Z9SitdW8Y68rAwM6o'

describe('password hashing (argon2id)', () => {
  it('verifies a hash stored by an earlier argon2 release', async () => {
    await expect(verifyPassword(LEGACY_HASH, LEGACY_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(LEGACY_HASH, PASSWORD)).resolves.toBe(false)
  })

  it('produces a PHC-format argon2id hash, not the plaintext', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(hash).not.toContain(PASSWORD)
  })

  it('verifies a correct password', async () => {
    const hash = await hashPassword(PASSWORD)
    await expect(verifyPassword(hash, PASSWORD)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD)
    await expect(verifyPassword(hash, 'wrong-password-value')).resolves.toBe(false)
  })

  it('salts so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)])
    expect(a).not.toBe(b)
    await expect(verifyPassword(a, PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(b, PASSWORD)).resolves.toBe(true)
  })
})
