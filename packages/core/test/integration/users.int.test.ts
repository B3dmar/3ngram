// SPDX-License-Identifier: Apache-2.0
// Integration — createUser provisioning + duplicate-email conflict, against the
// real runtime role (app_user, NOBYPASSRLS). `users` is a pre-tenant system
// table (no RLS), so createUser goes through the narrow packages/db admin
// helper rather than withTenant(). Runs on the CI ephemeral Neon branch.
//
// Reuses packages/db integration infra (ownerPool/seedUser).
import { closeDb, DuplicateEmailError } from '@3ngram/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, ownerPool, seedUser } from '../../../db/test/integration/helpers.js'
import { verifyPassword } from '../../src/auth/password.js'
import { createUser } from '../../src/auth/users.js'

const PASSWORD = 'provision-test-password'
const emails: string[] = []

function uniqueEmail(label: string): string {
  const email = `core-${label}-${crypto.randomUUID()}@test.local`
  emails.push(email)
  return email
}

afterAll(async () => {
  if (emails.length > 0) {
    await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [emails])
  }
  await closeDb()
  await closePools()
})
beforeEach(() => {
  emails.length = 0
})

describe('createUser (runtime role, real admin helper)', () => {
  it('provisions a user and stores a verifiable argon2id hash', async () => {
    const email = uniqueEmail('new')
    const user = await createUser(email, PASSWORD)

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(user.email).toBe(email)

    const { rows } = await ownerPool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    )
    const storedHash = rows[0]?.password_hash
    expect(storedHash?.startsWith('$argon2id$')).toBe(true)
    await expect(verifyPassword(storedHash ?? '', PASSWORD)).resolves.toBe(true)
  })

  it('lowercases the email at the validation boundary', async () => {
    const email = uniqueEmail('case')
    const user = await createUser(email.toUpperCase(), PASSWORD)
    expect(user.email).toBe(email)
  })

  it('rejects a duplicate email with DuplicateEmailError', async () => {
    const email = uniqueEmail('dupe')
    await seedUser(email)
    await expect(createUser(email, PASSWORD)).rejects.toBeInstanceOf(DuplicateEmailError)
  })
})
