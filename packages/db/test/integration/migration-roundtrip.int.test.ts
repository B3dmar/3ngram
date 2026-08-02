// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 4 (docs/concepts/testing.mdx): the migrated database matches the schema
// the code believes in — structure drift detector (owner connection).
import { afterAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from './helpers.js'

afterAll(closePools)

describe('migration round-trip structure', () => {
  it('all 24 tables exist', async () => {
    const r = await ownerPool.query(
      `SELECT count(*) AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name NOT LIKE '\\_\\_%'`,
    )
    // 16 + password_reset_tokens (0015) + email_verification_tokens (0017)
    // + the four 0022 cost/plan tables + budget_reservations (0023)
    // + user_profile_attributes (0026) = 24
    expect(Number(r.rows[0].n)).toBe(24)
  })

  it('19 tenant_isolation policies, all with the NULLIF guard', async () => {
    const r = await ownerPool.query(
      `SELECT count(*) AS n FROM pg_policies WHERE policyname = 'tenant_isolation'
       AND qual LIKE '%NULLIF%'`,
    )
    // 12 + password_reset_tokens (0015) + email_verification_tokens (0017)
    // + the two 0022 tenant-scoped cost tables + budget_reservations (0023)
    // + user_profile_attributes (0026) = 18, + audit_log (0029) = 19
    // (the two 0022 service/global tables have no RLS)
    expect(Number(r.rows[0].n)).toBe(19)
  })

  it('FSM trigger is armed on commitments', async () => {
    const r = await ownerPool.query(
      `SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'commitments_fsm_guard'`,
    )
    expect(Number(r.rows[0].n)).toBe(1)
  })

  it('oauth_clients persists confidential-client fields (S4 / PR #52 review)', async () => {
    const r = await ownerPool.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'oauth_clients' AND column_name IN ('token_endpoint_auth_method', 'client_secret_hash')
       ORDER BY column_name`,
    )
    expect(r.rows.map((x) => x.column_name)).toEqual([
      'client_secret_hash',
      'token_endpoint_auth_method',
    ])
    expect(r.rows[1].column_default).toContain('none')
    expect(r.rows[0].is_nullable).toBe('YES')
  })

  it('oauth_clients rejects invalid auth methods and inconsistent secrets (0005)', async () => {
    // typo'd method
    await expect(
      ownerPool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
         VALUES ('probe1', 'p', '[]', 'client_secret_psot')`,
      ),
    ).rejects.toThrow(/oauth_clients_auth_method_check/)
    // confidential without a secret hash
    await expect(
      ownerPool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
         VALUES ('probe2', 'p', '[]', 'client_secret_post')`,
      ),
    ).rejects.toThrow(/oauth_clients_secret_consistency_check/)
    // public WITH a secret hash
    await expect(
      ownerPool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash)
         VALUES ('probe3', 'p', '[]', 'none', 'h')`,
      ),
    ).rejects.toThrow(/oauth_clients_secret_consistency_check/)
    // valid confidential row, then clean up
    await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash)
       VALUES ('probe4', 'p', '[]', 'client_secret_post', 'hash')`,
    )
    await ownerPool.query(`DELETE FROM oauth_clients WHERE client_id LIKE 'probe%'`)
  })

  it('oauth_clients defaults DCR and accepts only known registration methods (0027)', async () => {
    const inserted = await ownerPool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES ('probe-registration-default', 'p', '[]')
       RETURNING registration_method`,
    )
    expect(inserted.rows[0].registration_method).toBe('dynamic_registration')
    await expect(
      ownerPool.query(
        `INSERT INTO oauth_clients
           (client_id, client_name, redirect_uris, registration_method)
         VALUES ('probe-registration-invalid', 'p', '[]', 'unknown')`,
      ),
    ).rejects.toThrow(/oauth_clients_registration_method_check/)
    await ownerPool.query(`DELETE FROM oauth_clients WHERE client_id LIKE 'probe-registration-%'`)
  })

  it('HNSW index exists on memories.embedding', async () => {
    const r = await ownerPool.query(
      `SELECT count(*) AS n FROM pg_indexes
       WHERE tablename = 'memories' AND indexdef LIKE '%hnsw%'`,
    )
    expect(Number(r.rows[0].n)).toBe(1)
  })

  it('auth resolvers: SECURITY DEFINER, EXECUTE denied to PUBLIC, granted to app_user', async () => {
    // ACLs inspected via aclexplode (review): prosecdef alone would
    // pass a resolver left PUBLIC-executable. NULL proacl = default privs
    // (PUBLIC may execute) — the LEFT JOIN + bool_or makes that fail too.
    const r = await ownerPool.query(
      `SELECT p.proname,
              p.prosecdef,
              coalesce(bool_or(a.grantee = 0), false) AS public_exec,
              coalesce(bool_or(pg_get_userbyid(a.grantee) = 'app_user'), false) AS app_exec
       FROM pg_proc p
       LEFT JOIN LATERAL aclexplode(p.proacl) a ON a.privilege_type = 'EXECUTE'
       WHERE p.proname LIKE 'auth\\_%'
       GROUP BY p.proname, p.prosecdef`,
    )
    // The 4 credential resolvers (0003) + auth_client_has_grants, the GC's
    // tenant-less token/code existence check (0014) + auth_consume_password_reset_token
    // (0015) + auth_reset_password & auth_peek_reset_token (0016) +
    // auth_verify_email & auth_peek_email_verification_token (0017) +
    // auth_create_unverified_signup & auth_retry_unverified_signup (0018) +
    // auth_resend_email_verification (0021): all
    // SECURITY DEFINER, PUBLIC-revoked, app_user-granted.
    expect(r.rows).toHaveLength(13)
    for (const row of r.rows) {
      expect(row.prosecdef, `${row.proname} SECURITY DEFINER`).toBe(true)
      expect(row.public_exec, `${row.proname} must not be PUBLIC-executable`).toBe(false)
      expect(row.app_exec, `${row.proname} must be executable by app_user`).toBe(true)
    }
  })
})
