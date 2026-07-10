// SPDX-License-Identifier: Apache-2.0
// Ephemeral-DB guard (P0 hardening after the 2026-06-12 prod-truncate incident).
//
// resetDomainTables() TRUNCATEs domain tables CASCADE. If DATABASE_URL ever
// resolves to a non-ephemeral (production) host — as it did when repo-root .env
// carried prod creds — that truncate destroys real memory data (docs/concepts/memory-model.mdx hard
// rule 1). This guard makes a truncate against prod IMPOSSIBLE: before any
// truncate the target DB must be provably ephemeral, otherwise we abort loudly
// and exit non-zero. It checks BOTH DATABASE_URL (runtime) and
// DATABASE_URL_UNPOOLED (owner) — either could point at prod.
//
// Provably ephemeral =
//   - host on the local allowlist (localhost, 127.0.0.1, ::1), OR
//   - the explicit env flag I_AM_AN_EPHEMERAL_DB=1 is set.
//
// NOTE: a '.neon.tech' suffix is NOT proof of ephemerality. Production
// DATABASE_URL is itself a Neon pooled host (docs/operate.mdx),
// so the provider suffix cannot distinguish a prod DB from a throwaway CI
// branch — the exact prod URL from the 2026-06-12 incident ends in
// '.neon.tech'. Neon branches are made provably ephemeral by the explicit flag
// instead (CI sets I_AM_AN_EPHEMERAL_DB=1 on the integration step).

const EPHEMERAL_HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'] as const
const EPHEMERAL_ENV_FLAG = 'I_AM_AN_EPHEMERAL_DB'

const GUARDED_DB_ENV_VARS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'] as const

/** Extract the lowercased host from a Postgres connection string. */
export function hostFromConnectionString(connectionString: string): string {
  // new URL() handles ipv6 brackets, ports, userinfo, and query params; pg
  // connection strings are URL-shaped (postgres://user:pw@host:port/db?...).
  const { hostname } = new URL(connectionString)
  // URL() returns ipv6 hosts wrapped in brackets ([::1]); strip them so the
  // allowlist comparison is literal.
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * A host is ephemeral only if it is on the local allowlist. A managed-provider
 * suffix (e.g. '.neon.tech') is deliberately NOT accepted: prod runs on the
 * same provider, so the suffix cannot prove the target is a throwaway branch.
 * Remote ephemeral branches must opt in via I_AM_AN_EPHEMERAL_DB=1.
 */
export function isEphemeralHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return (EPHEMERAL_HOST_ALLOWLIST as readonly string[]).includes(normalized)
}

/** True when the explicit override flag is set to '1'. */
export function ephemeralFlagSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EPHEMERAL_ENV_FLAG] === '1'
}

/**
 * Assert the integration-test target DB is provably ephemeral. Throws (so the
 * caller aborts and the process exits non-zero) when ANY guarded connection
 * string points at a non-ephemeral host and the override flag is not set.
 *
 * The flag is a deliberate, explicit escape hatch (CI sets it on the integration
 * step); without it a prod host — even with valid prod creds — cannot be
 * truncated.
 */
export function assertEphemeralTarget(env: NodeJS.ProcessEnv = process.env): void {
  if (ephemeralFlagSet(env)) return

  const offenders: string[] = []
  for (const name of GUARDED_DB_ENV_VARS) {
    const connectionString = env[name]
    if (!connectionString) continue
    let host: string
    try {
      host = hostFromConnectionString(connectionString)
    } catch {
      // An unparseable connection string is not provably ephemeral — refuse.
      offenders.push(`${name} (unparseable connection string)`)
      continue
    }
    if (!isEphemeralHost(host)) offenders.push(`${name} -> ${host}`)
  }

  if (offenders.length > 0) {
    throw new Error(
      [
        'EPHEMERAL-DB GUARD: refusing to TRUNCATE — target database is not provably ephemeral.',
        `Non-ephemeral target(s): ${offenders.join(', ')}.`,
        'Integration tests destroy data; they may only run against an ephemeral DB',
        '(localhost, 127.0.0.1, ::1) or with',
        `${EPHEMERAL_ENV_FLAG}=1 explicitly set (the only way to mark a remote branch`,
        'ephemeral — a managed-provider host suffix is not proof). Repo-root .env must NEVER carry a plain',
        'DATABASE_URL pointing at production (use PROD_DATABASE_URL for local prod refs).',
        'See AGENTS.md "Database / env safety".',
      ].join(' '),
    )
  }
}
