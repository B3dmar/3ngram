// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  actorKindSchema,
  commitmentStatusSchema,
  edgeTypeSchema,
  eventKindSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  proposalStatusSchema,
  tokenEndpointAuthMethodSchema,
} from '@3ngram/schema'
import { describe, expect, it } from 'vitest'

const initSql = readFileSync(join(import.meta.dirname, '../migrations/0000_init.sql'), 'utf8')
const authRlsSql = readFileSync(
  join(import.meta.dirname, '../migrations/0002_auth_rls.sql'),
  'utf8',
)
const resolversSql = readFileSync(
  join(import.meta.dirname, '../migrations/0003_auth_resolvers.sql'),
  'utf8',
)
const clientAuthSql = readFileSync(
  join(import.meta.dirname, '../migrations/0005_client_auth_constraints.sql'),
  'utf8',
)
// 0009 widens memory_events_kind_check with 'embed_failed' (the embed-on-write
// failure path slice 3) — fold it into the drift corpus so the
// generated CHECK is asserted to carry the new enum value.
const eventKindSql = readFileSync(
  join(import.meta.dirname, '../migrations/0009_event_kind_embed_failed.sql'),
  'utf8',
)
// 0015 adds password_reset_tokens (RLS-enabled, tenant_isolation policy) + the
// SECURITY DEFINER auth_consume_password_reset_token resolver —
// fold it into the corpus so the new policy/RLS/REVOKE are drift-checked.
const passwordResetSql = readFileSync(
  join(import.meta.dirname, '../migrations/0015_password_reset_tokens.sql'),
  'utf8',
)
// 0016 adds the atomic, per-user-serialized auth_reset_password resolver (issue
//  takeover fix) — fold it in so its SECURITY DEFINER hygiene, advisory-lock
// serialization, sibling-burn, and REVOKE are drift-checked.
const passwordResetAtomicSql = readFileSync(
  join(import.meta.dirname, '../migrations/0016_password_reset_atomic.sql'),
  'utf8',
)
// 0017 adds public-signup email verification tokens and their atomic consume +
// peek resolvers. Fold it in so RLS and SECURITY DEFINER hygiene
// are drift-checked with the other pre-tenant auth paths.
const emailVerificationSql = readFileSync(
  join(import.meta.dirname, '../migrations/0017_luxuriant_thunderball.sql'),
  'utf8',
)
// 0018 hardens self-serve signup token issuance: initial user creation and
// duplicate retries mint verification tokens atomically with their user writes.
const unverifiedSignupRetrySql = readFileSync(
  join(import.meta.dirname, '../migrations/0018_unverified_signup_retry.sql'),
  'utf8',
)
// 0019 binds verification tokens to a client-held proof so a mailbox-only click
// cannot activate a password chosen by a different requester.
const signupClientProofSql = readFileSync(
  join(import.meta.dirname, '../migrations/0019_signup_client_proof.sql'),
  'utf8',
)
const allMigrations =
  initSql +
  authRlsSql +
  resolversSql +
  clientAuthSql +
  eventKindSql +
  passwordResetSql +
  passwordResetAtomicSql +
  emailVerificationSql +
  unverifiedSignupRetrySql +
  signupClientProofSql
const rolesSql = readFileSync(join(import.meta.dirname, '../provision-roles.sql'), 'utf8')

describe('0000_init.sql ↔ @3ngram/schema drift', () => {
  it('every enum value appears in its generated CHECK constraint', () => {
    const allValues = [
      ...memoryTypeSchema.options,
      ...memoryStatusSchema.options,
      ...edgeTypeSchema.options,
      ...eventKindSchema.options,
      ...actorKindSchema.options,
      ...commitmentStatusSchema.options,
      ...proposalStatusSchema.options,
      ...tokenEndpointAuthMethodSchema.options,
    ]
    for (const v of allValues) {
      expect(allMigrations, `enum value '${v}' missing from generated CHECKs`).toContain(`'${v}'`)
    }
  })

  it('every RLS policy carries the NULLIF guard (S3 finding 1)', () => {
    const policies = allMigrations.match(/CREATE POLICY "tenant_isolation"[^;]+;/g) ?? []
    // 8 memory-domain/ops + 6 identity (user_sessions, api_keys, oauth_codes,
    // oauth_tokens, password_reset_tokens, email_verification_tokens)
    expect(policies.length).toBe(14)
    for (const p of policies) {
      expect(p).toContain(`NULLIF(current_setting('app.user_id', true), '')::uuid`)
    }
  })

  it('user-owned identity tables are RLS-enabled (PR #22 review)', () => {
    for (const t of [
      'user_sessions',
      'api_keys',
      'oauth_codes',
      'oauth_tokens',
      'password_reset_tokens',
      'email_verification_tokens',
    ]) {
      expect(allMigrations).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`)
    }
  })

  it('cross-tenant references are unrepresentable: composite (user_id, id) FKs', () => {
    expect(initSql).toContain(
      '("user_id","from_id") REFERENCES "public"."memories"("user_id","id")',
    )
    expect(initSql).toContain('("user_id","to_id") REFERENCES "public"."memories"("user_id","id")')
    expect(initSql).toContain(
      '("user_id","memory_id") REFERENCES "public"."memories"("user_id","id")',
    )
  })

  it('edge uniqueness and no-self-edge are constraints, not conventions', () => {
    expect(initSql).toMatch(/memory_edges_unique_idx.*user_id.*from_id.*to_id.*edge_type/)
    expect(initSql).toContain('"memory_edges"."from_id" <> "memory_edges"."to_id"')
  })

  it('bi-temporal validity CHECKs exist on memories and facts', () => {
    const validity = initSql.match(/"valid_to" IS NULL OR .*"valid_from" <= .*"valid_to"/g) ?? []
    expect(validity.length).toBe(2)
  })
})

describe('oauth_clients constraints (0005, PR #53 review)', () => {
  it('auth-method CHECK is generated from the schema enum', () => {
    for (const m of tokenEndpointAuthMethodSchema.options) {
      expect(clientAuthSql).toContain(`'${m}'`)
    }
    expect(clientAuthSql).toContain('oauth_clients_auth_method_check')
  })
  it('secret-consistency CHECK ties confidential methods to a present hash', () => {
    expect(clientAuthSql).toContain('oauth_clients_secret_consistency_check')
    expect(clientAuthSql).toMatch(/= 'none' AND .*client_secret_hash.* IS NULL/)
    expect(clientAuthSql).toMatch(/<> 'none' AND .*client_secret_hash.* IS NOT NULL/)
  })
})

describe('pre-tenant auth resolvers (0003)', () => {
  const fns = [
    'auth_resolve_session',
    'auth_resolve_api_key',
    'auth_resolve_oauth_token',
    'auth_consume_oauth_code',
  ]

  it('every resolver is SECURITY DEFINER with a pinned search_path', () => {
    const defs = resolversSql.match(/CREATE OR REPLACE FUNCTION[^$]+\$\$/g) ?? []
    expect(defs.length).toBe(4)
    for (const d of defs) {
      expect(d).toContain('SECURITY DEFINER')
      expect(d).toContain('SET search_path = public, pg_temp')
    }
  })

  it('EXECUTE is revoked from PUBLIC in the migration and granted in provision-roles', () => {
    for (const f of fns) {
      expect(resolversSql).toContain(`REVOKE ALL ON FUNCTION ${f}(text) FROM PUBLIC`)
      expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${f}(text) TO app_user`)
    }
  })
})

describe('password-reset consume resolver (0015, issue #267)', () => {
  const fn = 'auth_consume_password_reset_token'

  it('is SECURITY DEFINER with a pinned search_path and atomic single-use guard', () => {
    expect(passwordResetSql).toContain(`CREATE OR REPLACE FUNCTION ${fn}(p_token_hash text)`)
    expect(passwordResetSql).toContain('SECURITY DEFINER')
    expect(passwordResetSql).toContain('SET search_path = public, pg_temp')
    // single-use + expiry guard: only an unconsumed, unexpired token wins
    expect(passwordResetSql).toMatch(/consumed_at IS NULL AND expires_at > now\(\)/)
  })

  it('REVOKEs EXECUTE from PUBLIC in the migration; the grant lives in provision-roles', () => {
    expect(passwordResetSql).toContain(`REVOKE ALL ON FUNCTION ${fn}(text) FROM PUBLIC`)
    // fresh-install lesson: the GRANT must NOT be in the migration —
    // it would abort a fresh self-host where app_user does not exist yet.
    expect(passwordResetSql).not.toContain('GRANT EXECUTE')
    expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${fn}(text) TO app_user`)
  })
})

describe('password-reset atomic resolver (0016, issue #267 takeover fix)', () => {
  const fn = 'auth_reset_password'

  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(passwordResetAtomicSql).toContain(
      `CREATE OR REPLACE FUNCTION ${fn}(p_token_hash text, p_new_password_hash text)`,
    )
    expect(passwordResetAtomicSql).toContain('SECURITY DEFINER')
    expect(passwordResetAtomicSql).toContain('SET search_path = public, pg_temp')
  })

  it('serializes per user and consumes the token under the lock', () => {
    // advisory xact lock keyed per user (two-arg form: private namespace + uid)
    expect(passwordResetAtomicSql).toMatch(
      /pg_advisory_xact_lock\(hashtext\('auth_reset_password'\), hashtext\(v_user_id::text\)\)/,
    )
    // single-use + expiry guard mirrors the consume resolver
    expect(passwordResetAtomicSql).toMatch(/consumed_at IS NULL AND expires_at > now\(\)/)
  })

  it('burns ALL sibling tokens and revokes ALL sessions in the same tx', () => {
    expect(passwordResetAtomicSql).toMatch(
      /DELETE FROM user_sessions s WHERE s\.user_id = v_user_id/,
    )
    expect(passwordResetAtomicSql).toMatch(
      /UPDATE password_reset_tokens t\s+SET consumed_at = now\(\)\s+WHERE t\.user_id = v_user_id AND t\.consumed_at IS NULL/,
    )
  })

  it('REVOKEs EXECUTE from PUBLIC in the migration; the grant lives in provision-roles', () => {
    expect(passwordResetAtomicSql).toContain(`REVOKE ALL ON FUNCTION ${fn}(text, text) FROM PUBLIC`)
    // fresh-install lesson: the GRANT must NOT be in the migration.
    expect(passwordResetAtomicSql).not.toContain('GRANT EXECUTE')
    expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${fn}(text, text) TO app_user`)
  })

  it('ships a read-only peek resolver (DoS hardening) revoked + granted the same way', () => {
    const peek = 'auth_peek_reset_token'
    expect(passwordResetAtomicSql).toContain(
      `CREATE OR REPLACE FUNCTION ${peek}(p_token_hash text)`,
    )
    expect(passwordResetAtomicSql).toContain('SECURITY DEFINER')
    expect(passwordResetAtomicSql).toContain('SET search_path = public, pg_temp')
    // read-only: STABLE, a bare SELECT, and no UPDATE/consume of the token
    expect(passwordResetAtomicSql).toMatch(
      /CREATE OR REPLACE FUNCTION auth_peek_reset_token[\s\S]*?STABLE/,
    )
    expect(passwordResetAtomicSql).toContain(`REVOKE ALL ON FUNCTION ${peek}(text) FROM PUBLIC`)
    expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${peek}(text) TO app_user`)
  })
})

describe('email verification atomic resolver (0017, issue #349 public signup)', () => {
  const verify = 'auth_verify_email'
  const peek = 'auth_peek_email_verification_token'

  it('adds the RLS-owned token table and backfills existing users as verified', () => {
    expect(emailVerificationSql).toContain('CREATE TABLE "email_verification_tokens"')
    expect(emailVerificationSql).toContain(
      'ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY',
    )
    expect(emailVerificationSql).toContain('ALTER TABLE "users" ADD COLUMN "email_verified_at"')
    expect(emailVerificationSql).toContain(
      'UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL',
    )
  })

  it('verify resolver is SECURITY DEFINER with a pinned search_path', () => {
    expect(emailVerificationSql).toContain(
      `CREATE OR REPLACE FUNCTION ${verify}(p_token_hash text)`,
    )
    expect(emailVerificationSql).toContain('SECURITY DEFINER')
    expect(emailVerificationSql).toContain('SET search_path = public, pg_temp')
  })

  it('serializes per user, consumes under the lock, marks verified, and burns siblings', () => {
    expect(emailVerificationSql).toMatch(
      /pg_advisory_xact_lock\(hashtext\('auth_verify_email'\), hashtext\(v_user_id::text\)\)/,
    )
    expect(emailVerificationSql).toMatch(/consumed_at IS NULL AND expires_at > now\(\)/)
    expect(emailVerificationSql).toMatch(
      /SET email_verified_at = COALESCE\(email_verified_at, now\(\)\), updated_at = now\(\)/,
    )
    expect(emailVerificationSql).toMatch(
      /UPDATE email_verification_tokens t\s+SET consumed_at = now\(\)\s+WHERE t\.user_id = v_user_id AND t\.consumed_at IS NULL/,
    )
  })

  it('ships a read-only peek resolver and keeps grants out of the migration', () => {
    expect(emailVerificationSql).toContain(`CREATE OR REPLACE FUNCTION ${peek}(p_token_hash text)`)
    expect(emailVerificationSql).toMatch(
      /CREATE OR REPLACE FUNCTION auth_peek_email_verification_token[\s\S]*?STABLE/,
    )
    expect(emailVerificationSql).toContain(`REVOKE ALL ON FUNCTION ${peek}(text) FROM PUBLIC`)
    expect(emailVerificationSql).toContain(`REVOKE ALL ON FUNCTION ${verify}(text) FROM PUBLIC`)
    expect(emailVerificationSql).not.toContain('GRANT EXECUTE')
    expect(signupClientProofSql).toContain(`REVOKE ALL ON FUNCTION ${peek}(text, text) FROM PUBLIC`)
    expect(signupClientProofSql).toContain(
      `REVOKE ALL ON FUNCTION ${verify}(text, text) FROM PUBLIC`,
    )
    expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${peek}(text, text) TO app_user`)
    expect(rolesSql).toContain(`GRANT EXECUTE ON FUNCTION ${verify}(text, text) TO app_user`)
  })
})

describe('signup token issuance resolvers (0018, PR #356 P1)', () => {
  const create = 'auth_create_unverified_signup'
  const retry = 'auth_retry_unverified_signup'

  it('creates both SECURITY DEFINER functions with pinned search_path', () => {
    expect(unverifiedSignupRetrySql).toContain(
      `CREATE OR REPLACE FUNCTION ${create}(\n  p_email text,`,
    )
    expect(unverifiedSignupRetrySql).toContain(
      `CREATE OR REPLACE FUNCTION ${retry}(\n  p_user_id uuid,`,
    )
    const defs = unverifiedSignupRetrySql.match(/CREATE OR REPLACE FUNCTION auth_[^$]+\$\$/g) ?? []
    expect(defs).toHaveLength(2)
    for (const d of defs) {
      expect(d).toContain('SECURITY DEFINER')
      expect(d).toContain('SET search_path = public, pg_temp')
    }
  })

  it('initial signup inserts the user and first token in one resolver', () => {
    expect(unverifiedSignupRetrySql).toMatch(
      /INSERT INTO users \(email, password_hash, email_verified_at\)/,
    )
    expect(unverifiedSignupRetrySql).toMatch(
      /INSERT INTO email_verification_tokens \(user_id, token_hash, expires_at\)\s+VALUES \(v_user_id, p_token_hash, p_expires_at\)/,
    )
  })

  it('retry serializes with verification, CASes the password, burns stale links, and mints fresh', () => {
    expect(unverifiedSignupRetrySql).toMatch(
      /pg_advisory_xact_lock\(hashtext\('auth_verify_email'\), hashtext\(p_user_id::text\)\)/,
    )
    expect(unverifiedSignupRetrySql).toMatch(/u\.password_hash = p_expected_password_hash/)
    expect(unverifiedSignupRetrySql).toMatch(/u\.email_verified_at IS NULL/)
    expect(unverifiedSignupRetrySql).toMatch(
      /UPDATE email_verification_tokens t\s+SET consumed_at = now\(\)\s+WHERE t\.user_id = p_user_id AND t\.consumed_at IS NULL/,
    )
    expect(unverifiedSignupRetrySql).toMatch(
      /INSERT INTO email_verification_tokens \(user_id, token_hash, expires_at\)\s+VALUES \(p_user_id, p_token_hash, p_expires_at\)/,
    )
  })

  it('REVOKEs EXECUTE from PUBLIC in the migration; grants live in provision-roles', () => {
    expect(unverifiedSignupRetrySql).toContain(
      `REVOKE ALL ON FUNCTION ${create}(text, text, text, timestamp with time zone) FROM PUBLIC`,
    )
    expect(unverifiedSignupRetrySql).toContain(
      `REVOKE ALL ON FUNCTION ${retry}(uuid, text, text, text, timestamp with time zone) FROM PUBLIC`,
    )
    expect(unverifiedSignupRetrySql).not.toContain('GRANT EXECUTE')
    expect(signupClientProofSql).toContain(
      `REVOKE ALL ON FUNCTION ${create}(text, text, text, text, timestamp with time zone) FROM PUBLIC`,
    )
    expect(signupClientProofSql).toContain(
      `REVOKE ALL ON FUNCTION ${retry}(uuid, text, text, text, text, timestamp with time zone) FROM PUBLIC`,
    )
    expect(rolesSql).toContain(
      `GRANT EXECUTE ON FUNCTION ${create}(text, text, text, text, timestamp with time zone) TO app_user`,
    )
    expect(rolesSql).toContain(
      `GRANT EXECUTE ON FUNCTION ${retry}(uuid, text, text, text, text, timestamp with time zone) TO app_user`,
    )
  })
})

describe('signup verification client proof binding (0019, PR #356 P2)', () => {
  it('adds a mandatory SHA-256 client proof hash to verification tokens', () => {
    expect(signupClientProofSql).toContain(
      'ALTER TABLE "email_verification_tokens" ADD COLUMN "client_proof_hash" text',
    )
    expect(signupClientProofSql).toContain(
      'ALTER TABLE "email_verification_tokens" ALTER COLUMN "client_proof_hash" SET NOT NULL',
    )
    expect(signupClientProofSql).toContain(
      `"email_verification_tokens_client_proof_hash_check" CHECK ("email_verification_tokens"."client_proof_hash" ~ '^[0-9a-f]{64}$')`,
    )
  })

  it('drops the token-only verifier functions so proof is required', () => {
    expect(signupClientProofSql).toContain(
      'DROP FUNCTION IF EXISTS auth_peek_email_verification_token(text)',
    )
    expect(signupClientProofSql).toContain('DROP FUNCTION IF EXISTS auth_verify_email(text)')
    expect(signupClientProofSql).toContain(
      'DROP FUNCTION IF EXISTS auth_create_unverified_signup(text, text, text, timestamp with time zone)',
    )
    expect(signupClientProofSql).toContain(
      'DROP FUNCTION IF EXISTS auth_retry_unverified_signup(uuid, text, text, text, timestamp with time zone)',
    )
  })

  it('requires client proof in peek and atomic verify lookup paths', () => {
    expect(signupClientProofSql).toContain(
      'CREATE OR REPLACE FUNCTION auth_peek_email_verification_token(\n  p_token_hash text,\n  p_client_proof_hash text',
    )
    expect(signupClientProofSql).toContain(
      'CREATE OR REPLACE FUNCTION auth_verify_email(\n  p_token_hash text,\n  p_client_proof_hash text',
    )
    expect(signupClientProofSql).toMatch(
      /t\.token_hash = p_token_hash[\s\S]*t\.client_proof_hash = p_client_proof_hash/,
    )
    expect(signupClientProofSql).toMatch(
      /token_hash = p_token_hash[\s\S]*client_proof_hash = p_client_proof_hash[\s\S]*consumed_at IS NULL/,
    )
  })

  it('stores client proof hash atomically with initial and retry signup tokens', () => {
    expect(signupClientProofSql).toContain('p_client_proof_hash text')
    expect(signupClientProofSql).toMatch(
      /INSERT INTO email_verification_tokens \(user_id, token_hash, client_proof_hash, expires_at\)\s+VALUES \(v_user_id, p_token_hash, p_client_proof_hash, p_expires_at\)/,
    )
    expect(signupClientProofSql).toMatch(
      /INSERT INTO email_verification_tokens \(user_id, token_hash, client_proof_hash, expires_at\)\s+VALUES \(p_user_id, p_token_hash, p_client_proof_hash, p_expires_at\)/,
    )
  })
})

describe('provision-roles.sql append-and-supersede grants', () => {
  it('memory_events and audit_log are INSERT-only for the runtime role', () => {
    expect(rolesSql).toMatch(/GRANT SELECT, INSERT ON memory_events, audit_log/)
    expect(rolesSql).not.toMatch(/UPDATE[^\n]*memory_events/)
    expect(rolesSql).not.toMatch(/DELETE[^\n]*memory_events/)
  })

  it('no DELETE grant on any memory-domain table (the write path cannot destroy data)', () => {
    const memoryDomain =
      /DELETE[^\n]*(memories|memory_edges|commitments|facts|consolidation_proposals)/
    expect(rolesSql).not.toMatch(memoryDomain)
  })

  it('runtime role is NOBYPASSRLS', () => {
    expect(rolesSql).toContain('NOBYPASSRLS')
  })
})
