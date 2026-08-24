// SPDX-License-Identifier: Apache-2.0
// Integration coverage for account-deletion PII erasure
// through the RUNTIME role (app_user, NOBYPASSRLS) — the real RLS + grant path.
//
// Proves the append-only reconciliation END TO END:
//   - PII columns are redacted in place (memories/facts/fact_proposals/
//     commitments/users)
//   - NO memory-domain row is physically deleted (row counts unchanged) — the
//     runtime grant has no DELETE on memory data, so erasure CANNOT delete it
//   - sessions are deleted; api keys + oauth tokens are revoked (revoked_at)
//   - a second run is idempotent (already-erased marker short-circuits)
//   - RLS scopes erasure to the tenant (user B is untouched)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountDeletedError,
  closeDb,
  deletedEmail,
  ERASED_PII,
  eraseAccountData,
  insertApiKey,
  insertOauthTokenPair,
  insertPasswordResetToken,
  type NewOauthToken,
  resetPasswordAtomic,
  withTenant,
} from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string
const NOW = new Date('2026-06-27T00:00:00.000Z')

async function seedMemory(userId: string, topic: string, content: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, scope, tags, content_hash)
     VALUES ($1, 'note', $2, $3, 'work', '["t"]'::jsonb, encode(sha256($4::bytea), 'hex'))
     RETURNING id`,
    [userId, topic, content, content],
  )
  return r.rows[0].id as string
}

async function seedFact(userId: string, memoryId: string, value: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO facts (user_id, memory_id, subject, predicate, value)
     VALUES ($1, $2, 'subj', 'pred', $3)`,
    [userId, memoryId, value],
  )
}

// A staged fact proposal: user content that is NOT a `facts` row. The users row
// is tombstoned rather than deleted, so the FK's ON DELETE CASCADE never fires
// and this survives erasure unless it is redacted explicitly.
async function seedFactProposal(userId: string, memoryId: string, value: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO fact_proposals (user_id, memory_id, subject, predicate, value, memory_type, rationale)
     VALUES ($1, $2, 'proposed-subj', 'proposed-pred', $3, 'note', 'extracted by the model')`,
    [userId, memoryId, value],
  )
}

// agent_sessions is user-owned (excerpt, briefing topics, selector) and the
// users row is tombstoned, so the FK cascade never fires.
async function seedAgentSession(
  userId: string,
  sessionId: string,
  excerpt: string,
  topic: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO agent_sessions
       (user_id, agent, session_id, source, project, scope, selector, briefed_memories,
        last_message_excerpt, needs_look)
     VALUES ($1, 'codex', $2, 'startup', '3ngram', 'work', '{"kind":"all"}'::jsonb, $3::jsonb, $4,
             true)`,
    [
      userId,
      sessionId,
      JSON.stringify([{ id: crypto.randomUUID(), topic, status: 'open' }]),
      excerpt,
    ],
  )
}

async function countRows(table: string, userId: string): Promise<number> {
  const r = await ownerPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
    userId,
  ])
  return r.rows[0].n as number
}

beforeAll(async () => {
  userA = await seedUser('acct-del-a@test.local')
  userB = await seedUser('acct-del-b@test.local')
})
beforeEach(async () => {
  await resetDomainTables()
  // resetDomainTables truncates memory data only; restore both users' rows so the
  // identity erasure can run (seedUser upserts).
  userA = await seedUser('acct-del-a@test.local')
  userB = await seedUser('acct-del-b@test.local')
  // Identity credential tables are NOT in resetDomainTables — clear this suite's
  // own rows so a re-run does not collide on a unique hash (owner connection).
  await ownerPool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query('DELETE FROM oauth_codes WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query('DELETE FROM oauth_tokens WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1)', [
    [userA, userB],
  ])
  await ownerPool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
    [userA, userB],
  ])
  await ownerPool.query('DELETE FROM api_keys WHERE user_id = ANY($1)', [[userA, userB]])
})
afterAll(async () => {
  await resetDomainTables()
  // Remove both the live test users AND any user this suite erased (its email was
  // rewritten to the deletion marker). DELETE cascades to their credential rows.
  await ownerPool.query("DELETE FROM users WHERE email LIKE 'acct-del-%'")
  await ownerPool.query("DELETE FROM users WHERE email LIKE 'deleted-%@deleted.invalid'")
  await closeDb()
  await closePools()
})

describe('eraseAccountData — PII erasure (runtime role, real RLS + grants)', () => {
  it('redacts PII in place WITHOUT deleting memory rows, and revokes credentials', async () => {
    const m1 = await seedMemory(userA, 'secret topic', 'secret body one')
    await seedMemory(userA, 'second', 'secret body two')
    await seedFact(userA, m1, 'secret value')
    await seedFactProposal(userA, m1, 'secret proposed value')
    await seedAgentSession(userA, 'sess-a', 'secret last message', 'secret briefing topic')
    await ownerPool.query(
      `INSERT INTO user_retrieval_policy (user_id, mode, default_scope)
       VALUES ($1, 'default', 'private')`,
      [userA],
    )
    // Credentials: a session (deletable) + an api key + an oauth client/token.
    // Unique hashes per run — an erased user orphans (its email is rewritten), so
    // a fixed hash would collide on the unique constraint across runs.
    const uniq = crypto.randomUUID()
    const clientId = `c-del-${uniq}`
    await ownerPool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [userA, `sess-${uniq}`],
    )
    await ownerPool.query(
      `INSERT INTO api_keys (user_id, name, key_hash, prefix)
       VALUES ($1, 'k', $2, 'pfx')`,
      [userA, `key-${uniq}`],
    )
    await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, 'c', '[]'::jsonb)`,
      [clientId],
    )
    await ownerPool.query(
      `INSERT INTO oauth_tokens (user_id, token_hash, kind, client_id, scope, expires_at)
       VALUES ($1, $2, 'access', $3, 'memory:read', now() + interval '1 hour')`,
      [userA, `tok-${uniq}`, clientId],
    )
    // A pending, unexchanged authorization code — must NOT survive deletion, else
    // it could still mint fresh tokens after every credential reports revoked.
    await ownerPool.query(
      `INSERT INTO oauth_codes (user_id, code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
       VALUES ($1, $2, $3, 'https://app.test/cb', 'chal', 'memory:read', now() + interval '10 minutes')`,
      [userA, `code-${uniq}`, clientId],
    )
    // A pending password-reset token + email-verification token. The reset token
    // is the dangerous one: its resolver sets password_hash by user id WITHOUT a
    // deletion-marker check, so a stale link could re-enable login to the
    // tombstoned account. Both must be burned in the erasure tx.
    await ownerPool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [userA, `reset-${uniq}`],
    )
    await ownerPool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, client_proof_hash, expires_at)
       VALUES ($1, $2, encode(sha256($3::bytea), 'hex'), now() + interval '1 hour')`,
      [userA, `verify-${uniq}`, `proof-${uniq}`],
    )

    const memoriesBefore = await countRows('memories', userA)
    const result = await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))

    expect(result?.alreadyErased).toBe(false)
    expect(result?.memories).toBe(2)
    expect(result?.facts).toBe(1)
    expect(result?.factProposals).toBe(1)
    expect(result?.agentSessions).toBe(1)
    expect(result?.sessionsDeleted).toBe(1)
    expect(result?.apiKeysRevoked).toBe(1)
    expect(result?.oauthTokensRevoked).toBe(1)
    expect(result?.oauthCodesDeleted).toBe(1)
    expect(result?.passwordResetTokensDeleted).toBe(1)
    expect(result?.emailVerificationTokensDeleted).toBe(1)

    // NO memory-domain row was physically deleted — append-only intact.
    expect(await countRows('memories', userA)).toBe(memoriesBefore)
    expect(await countRows('facts', userA)).toBe(1)
    expect(await countRows('fact_proposals', userA)).toBe(1)
    expect(await countRows('agent_sessions', userA)).toBe(1)

    // PII is redacted in place.
    const mem = await ownerPool.query(
      'SELECT content, topic, tags FROM memories WHERE user_id = $1',
      [userA],
    )
    for (const row of mem.rows) {
      expect(row.content).toBe(ERASED_PII)
      expect(row.topic).toBe(ERASED_PII)
      expect(row.tags).toEqual([])
    }
    const fact = await ownerPool.query('SELECT subject, value FROM facts WHERE user_id = $1', [
      userA,
    ])
    expect(fact.rows[0].subject).toBe(ERASED_PII)
    expect(fact.rows[0].value).toBe(ERASED_PII)
    // A staged proposal carries the same content shape as a fact plus a
    // rationale; none of it may survive an erasure.
    const proposal = await ownerPool.query(
      'SELECT subject, predicate, value, rationale FROM fact_proposals WHERE user_id = $1',
      [userA],
    )
    expect(proposal.rows[0].subject).toBe(ERASED_PII)
    expect(proposal.rows[0].predicate).toBe(ERASED_PII)
    expect(proposal.rows[0].value).toBe(ERASED_PII)
    expect(proposal.rows[0].rationale).toBeNull()
    const session = await ownerPool.query(
      `SELECT project, scope, selector, briefed_memories, last_message_excerpt, needs_look
       FROM agent_sessions WHERE user_id = $1`,
      [userA],
    )
    expect(session.rows[0].project).toBeNull()
    expect(session.rows[0].scope).toBeNull()
    expect(session.rows[0].selector).toEqual({ kind: 'all' })
    expect(session.rows[0].briefed_memories).toEqual([])
    expect(session.rows[0].last_message_excerpt).toBe(ERASED_PII)
    // Reset with the watermark it is derived from: leaving it raised would park a
    // tombstoned account's whole session history in the closer's candidate index.
    expect(session.rows[0].needs_look).toBe(false)

    // Identity erased; the email becomes the deletion marker.
    const user = await ownerPool.query('SELECT email, password_hash FROM users WHERE id = $1', [
      userA,
    ])
    expect(user.rows[0].email).toBe(deletedEmail(userA))
    expect(user.rows[0].password_hash).not.toBe('x')

    // Sessions gone; credentials revoked.
    expect(await countRows('user_sessions', userA)).toBe(0)
    const key = await ownerPool.query('SELECT revoked_at FROM api_keys WHERE user_id = $1', [userA])
    expect(key.rows[0].revoked_at).not.toBeNull()
    const tok = await ownerPool.query('SELECT revoked_at FROM oauth_tokens WHERE user_id = $1', [
      userA,
    ])
    expect(tok.rows[0].revoked_at).not.toBeNull()

    // No pending authorization code survives — the exchange window is closed.
    expect(await countRows('oauth_codes', userA)).toBe(0)
    // No reset / verification token survives — the reset resolver can't rehydrate
    // the tombstoned account (auth-bypass closed).
    expect(await countRows('password_reset_tokens', userA)).toBe(0)
    expect(await countRows('email_verification_tokens', userA)).toBe(0)
    const policy = await ownerPool.query(
      'SELECT mode, default_scope FROM user_retrieval_policy WHERE user_id = $1',
      [userA],
    )
    expect(policy.rows[0]).toMatchObject({ mode: 'off', default_scope: null })

    await ownerPool.query('DELETE FROM oauth_codes WHERE client_id = $1', [clientId])
    await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
    await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  })

  it('is idempotent: a second erasure short-circuits on the deletion marker', async () => {
    await seedMemory(userA, 't', 'body')
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    const second = await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    expect(second?.alreadyErased).toBe(true)
    expect(second?.memories).toBe(0)
  })

  it('RLS scopes erasure to the tenant — user B is untouched', async () => {
    await seedMemory(userA, 'a-topic', 'a-body')
    await seedMemory(userB, 'b-topic', 'b-body')
    await seedAgentSession(userB, 'sess-b', 'b last message', 'b briefing')

    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))

    // B's memory keeps its PII; B's identity is unchanged.
    const bMem = await ownerPool.query('SELECT content, topic FROM memories WHERE user_id = $1', [
      userB,
    ])
    expect(bMem.rows[0].content).toBe('b-body')
    expect(bMem.rows[0].topic).toBe('b-topic')
    const bUser = await ownerPool.query('SELECT email FROM users WHERE id = $1', [userB])
    expect(bUser.rows[0].email).toBe('acct-del-b@test.local')
    const bSession = await ownerPool.query(
      'SELECT last_message_excerpt, project FROM agent_sessions WHERE user_id = $1',
      [userB],
    )
    expect(bSession.rows[0].last_message_excerpt).toBe('b last message')
    expect(bSession.rows[0].project).toBe('3ngram')
  })
})

// Credential-resurrection race: OAuth token issuance runs in SEPARATE
// db steps from the code consume. If a deletion lands between them, a naive insert
// would mint a LIVE token on the tombstoned user. insertOauthTokenPair takes the
// account-lifecycle advisory lock (the SAME one eraseAccountData takes) and
// refuses to insert when the user is tombstoned, so the two serialize: an
// issuance either commits-then-gets-revoked-by-deletion, or runs after deletion
// and is refused. Proven here against the runtime role + real RLS.
describe('OAuth issuance vs deletion — credential-resurrection race', () => {
  function tokenPair(clientId: string, uniq: string): [NewOauthToken, NewOauthToken] {
    const hourOut = new Date(Date.now() + 3_600_000)
    return [
      {
        tokenHash: `acc-${uniq}`,
        kind: 'access',
        clientId,
        scope: 'memory:read',
        expiresAt: hourOut,
      },
      {
        tokenHash: `ref-${uniq}`,
        kind: 'refresh',
        clientId,
        scope: 'memory:read',
        expiresAt: hourOut,
      },
    ]
  }
  async function countLiveTokens(userId: string): Promise<number> {
    const r = await ownerPool.query(
      `SELECT count(*)::int AS n FROM oauth_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    )
    return r.rows[0].n as number
  }

  it('normal issuance succeeds when no deletion is happening', async () => {
    const uniq = crypto.randomUUID()
    const clientId = `c-race-${uniq}`
    await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'c', '[]'::jsonb)`,
      [clientId],
    )
    const [access, refresh] = tokenPair(clientId, uniq)
    const issued = await insertOauthTokenPair(userA, access, refresh)
    expect(issued).toBe(true)
    // One issuance = a live access + refresh pair (two rows).
    expect(await countLiveTokens(userA)).toBe(2)

    await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
    await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  })

  it('refuses issuance AFTER deletion — no live token resurrects the account', async () => {
    const uniq = crypto.randomUUID()
    const clientId = `c-race-${uniq}`
    await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'c', '[]'::jsonb)`,
      [clientId],
    )
    // Simulate consume-done-then-deletion-then-insert: the userId is already in
    // hand (as if a code was just consumed), deletion commits, THEN the issuance
    // insert runs. The marker guard refuses it.
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    const [access, refresh] = tokenPair(clientId, uniq)
    const issued = await insertOauthTokenPair(userA, access, refresh)
    expect(issued).toBe(false)
    expect(await countLiveTokens(userA)).toBe(0)

    await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  })

  it('a token minted just BEFORE deletion is revoked by the deletion', async () => {
    const uniq = crypto.randomUUID()
    const clientId = `c-race-${uniq}`
    await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, 'c', '[]'::jsonb)`,
      [clientId],
    )
    const [access, refresh] = tokenPair(clientId, uniq)
    expect(await insertOauthTokenPair(userA, access, refresh)).toBe(true)
    // Deletion (winning the lock after issuance committed) revokes every live token.
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    expect(await countLiveTokens(userA)).toBe(0)

    await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
    await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  })
})

// API-key issuance vs deletion (the path Codex flagged): POST /auth/api-keys is
// session-authed, but a deletion can land between the auth resolve and the
// insertApiKey write. insertApiKey takes the account-lifecycle lock and refuses
// on a tombstoned user, so no live key is minted on a deleted account.
describe('API-key issuance vs deletion — credential-resurrection race', () => {
  async function countLiveKeys(userId: string): Promise<number> {
    const r = await ownerPool.query(
      `SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
    return r.rows[0].n as number
  }

  it('normal issuance succeeds when no deletion is happening', async () => {
    const uniq = crypto.randomUUID()
    const { id } = await insertApiKey(userA, 'live-key', `kh-${uniq}`, 'pfx')
    expect(id).toBeTruthy()
    expect(await countLiveKeys(userA)).toBe(1)
    await ownerPool.query('DELETE FROM api_keys WHERE user_id = $1', [userA])
  })

  it('refuses issuance AFTER deletion — AccountDeletedError, no live key', async () => {
    const uniq = crypto.randomUUID()
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    await expect(insertApiKey(userA, 'ghost-key', `kh-${uniq}`, 'pfx')).rejects.toBeInstanceOf(
      AccountDeletedError,
    )
    expect(await countLiveKeys(userA)).toBe(0)
  })
})

// Password-reset vs deletion: the resolver UPDATEs users.password_hash by id. A
// reset validated just before deletion must not set a real hash on the tombstone
// and re-enable login. Deletion takes the SAME auth_reset_password lock AND burns
// reset tokens, and the resolver refuses on the tombstone marker — so a post-
// deletion reset sets nothing and the password stays the erased sentinel.
describe('password-reset vs deletion — no password set on a tombstone', () => {
  async function passwordHashOf(userId: string): Promise<string> {
    const r = await ownerPool.query('SELECT password_hash FROM users WHERE id = $1', [userId])
    return r.rows[0].password_hash as string
  }

  it('a reset attempted AFTER deletion sets no password (token burned + tombstoned)', async () => {
    const uniq = crypto.randomUUID()
    const tokenHash = `rh-${uniq}`
    await insertPasswordResetToken(userA, {
      tokenHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    // Deletion burns the reset token, tombstones the row, erases the password.
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    const erasedHash = await passwordHashOf(userA)

    // The reset now finds no consumable token (burned) and would be refused by the
    // resolver's tombstone guard regardless — returns undefined, password unchanged.
    const resolved = await resetPasswordAtomic(tokenHash, 'argon2-new-hash')
    expect(resolved).toBeUndefined()
    expect(await passwordHashOf(userA)).toBe(erasedHash)
    expect(erasedHash).not.toBe('argon2-new-hash')
  })

  it('refuses to mint a reset token on a tombstoned account', async () => {
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, NOW))
    await expect(
      insertPasswordResetToken(userA, {
        tokenHash: `rh-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toBeInstanceOf(AccountDeletedError)
  })
})
