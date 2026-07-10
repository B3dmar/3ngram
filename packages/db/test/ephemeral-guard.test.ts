// SPDX-License-Identifier: Apache-2.0
// Proves the ephemeral-DB guard (P0 hardening, 2026-06-12 prod-truncate
// incident): a truncate must be IMPOSSIBLE against a non-ephemeral host, and
// must be allowed only against an allowlisted host or with the explicit flag.
// Pure host-parsing logic — no DB connection, runs in the unit suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertEphemeralTarget,
  hostFromConnectionString,
  isEphemeralHost,
} from './integration/ephemeral-guard.js'

const PROD = 'postgres://app_user:pw@ep-prod-main-abc123.eu-central-1.aws.example.com:5432/3ngram'
const NEON_BRANCH =
  'postgres://app_user:pw@ep-ci-branch-xyz789.eu-central-1.aws.neon.tech:5432/neondb'
const LOCAL = 'postgres://app_user:pw@localhost:5432/3ngram_test'
const LOCAL_IP = 'postgres://app_user:pw@127.0.0.1:5432/3ngram_test'
const LOCAL_IPV6 = 'postgres://app_user:pw@[::1]:5432/3ngram_test'

describe('hostFromConnectionString', () => {
  it('extracts the host from a Postgres URI', () => {
    expect(hostFromConnectionString(PROD)).toBe('ep-prod-main-abc123.eu-central-1.aws.example.com')
  })
  it('unwraps ipv6 brackets', () => {
    expect(hostFromConnectionString(LOCAL_IPV6)).toBe('::1')
  })
})

describe('isEphemeralHost', () => {
  it.each([['localhost'], ['127.0.0.1'], ['::1']])('treats %s as ephemeral', (host) => {
    expect(isEphemeralHost(host)).toBe(true)
  })
  it.each([
    ['ep-prod-main-abc123.eu-central-1.aws.example.com'],
    ['db.production.internal'],
    ['neon.tech.evil.com'],
    // A managed-provider suffix is NOT proof: prod runs on the same provider,
    // so a Neon branch host is not treated as ephemeral by host alone.
    ['ep-ci-branch-xyz789.eu-central-1.aws.neon.tech'],
  ])('treats %s as non-ephemeral', (host) => {
    expect(isEphemeralHost(host)).toBe(false)
  })
})

describe('assertEphemeralTarget', () => {
  it('ABORTS when DATABASE_URL points at a non-ephemeral host', () => {
    expect(() => assertEphemeralTarget({ DATABASE_URL: PROD })).toThrow(/EPHEMERAL-DB GUARD/)
  })

  it('ABORTS when DATABASE_URL_UNPOOLED (owner) points at prod even if runtime is local', () => {
    expect(() =>
      assertEphemeralTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: PROD }),
    ).toThrow(/DATABASE_URL_UNPOOLED/)
  })

  it('ABORTS even when prod creds are present (creds never make a host ephemeral)', () => {
    expect(() => assertEphemeralTarget({ DATABASE_URL: PROD })).toThrow()
  })

  it('ABORTS on a Neon host without the flag (prod DATABASE_URL is also *.neon.tech)', () => {
    expect(() => assertEphemeralTarget({ DATABASE_URL: NEON_BRANCH })).toThrow(/EPHEMERAL-DB GUARD/)
  })

  it('ABORTS on an unparseable connection string', () => {
    expect(() => assertEphemeralTarget({ DATABASE_URL: 'not a url' })).toThrow(
      /unparseable connection string/,
    )
  })

  it.each([
    [LOCAL],
    [LOCAL_IP],
    [LOCAL_IPV6],
  ])('PASSES when both connections are on the local allowlist (%s)', (url) => {
    expect(() =>
      assertEphemeralTarget({ DATABASE_URL: url, DATABASE_URL_UNPOOLED: url }),
    ).not.toThrow()
  })

  it('PASSES with the explicit I_AM_AN_EPHEMERAL_DB=1 flag even on a prod host', () => {
    expect(() =>
      assertEphemeralTarget({ DATABASE_URL: PROD, I_AM_AN_EPHEMERAL_DB: '1' }),
    ).not.toThrow()
  })

  it('PASSES on a Neon branch only with the explicit flag (how CI runs)', () => {
    expect(() =>
      assertEphemeralTarget({
        DATABASE_URL: NEON_BRANCH,
        DATABASE_URL_UNPOOLED: NEON_BRANCH,
        I_AM_AN_EPHEMERAL_DB: '1',
      }),
    ).not.toThrow()
  })

  it('does NOT honor the flag when set to a value other than 1', () => {
    expect(() =>
      assertEphemeralTarget({ DATABASE_URL: PROD, I_AM_AN_EPHEMERAL_DB: 'true' }),
    ).toThrow(/EPHEMERAL-DB GUARD/)
  })
})

// The guard must protect ALL DB access, not just the truncate. Integration
// suites perform SETUP writes (seedUser, INSERTs) before resetDomainTables ever
// runs, and some suites never call resetDomainTables at all. helpers.ts now
// asserts at MODULE LOAD, before the pools are constructed, so merely importing
// the module against a non-ephemeral target aborts — before any seedUser/setup
// write, the truncate, or a single connection is opened.
describe('helpers module-load guard (covers setup writes, not just truncate)', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.resetModules()
  })

  it('ABORTS at import against a prod host, before any pool is constructed', async () => {
    process.env.DATABASE_URL = PROD
    process.env.DATABASE_URL_UNPOOLED = PROD
    process.env.I_AM_AN_EPHEMERAL_DB = undefined
    // Importing helpers.ts triggers assertEphemeralTarget() at module top level,
    // before ownerPool/runtimePool exist — so seedUser/setup INSERTs in a suite
    // that never calls resetDomainTables() can never reach prod.
    await expect(import('./integration/helpers.js')).rejects.toThrow(/EPHEMERAL-DB GUARD/)
  })

  it('imports cleanly when the explicit ephemeral flag is set even on a prod host', async () => {
    process.env.DATABASE_URL = PROD
    process.env.DATABASE_URL_UNPOOLED = PROD
    process.env.I_AM_AN_EPHEMERAL_DB = '1'
    // Pools construct lazily on first query, so the import itself does not open a
    // connection; the flag (how CI runs) lets the module load without aborting.
    await expect(import('./integration/helpers.js')).resolves.toHaveProperty('seedUser')
  })
})
