// SPDX-License-Identifier: Apache-2.0
// Regression guard for the self-host DB credential scoping.
// Asserts, directly against compose.selfhost.yml, the two invariants that are
// easy to silently break:
//   1. The dedicated `preflight` service exports POSTGRES_PASSWORD as a discrete
//      env var (NOT only interpolated into a connection URL) — otherwise the
//      check-selfhost-secrets.sh preflight reads it empty and fails the happy path
//      even with a strong owner password. The secrets check runs in
//      `preflight` (which gates `postgres` before pgdata is ever initialized), not
//      in `migrations`, so the discrete env lives on `preflight`.
//   2. The long-running `server` service SCRUBS the owner credential
//      (POSTGRES_PASSWORD: "") so it never reaches the served app.
//
// Static line-scan (no YAML dep) so it runs in the install-free CI hygiene lane
// with `node --test` and built-ins only — same convention as
// check-license-boundary.test.mjs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const compose = readFileSync(join(repoRoot, 'compose.selfhost.yml'), 'utf8')

/** Return the lines of the 2-space-indented service block named `service`. */
function serviceBlock(text, service) {
  const lines = text.split('\n')
  const header = `  ${service}:`
  const start = lines.indexOf(header)
  assert.notEqual(start, -1, `service '${service}' not found in compose.selfhost.yml`)
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // A new 2-space-indented, non-comment key ends the block.
    if (/^ {2}\S/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

test('preflight service exports POSTGRES_PASSWORD as a discrete env var (secrets check can read it)', () => {
  const block = serviceBlock(compose, 'preflight')
  assert.match(
    block,
    /^ {6}POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/m,
    'preflight.environment must list POSTGRES_PASSWORD with a :? guard so check-selfhost-secrets.sh receives it',
  )
})

test('server service scrubs the owner credential (Outcome B: owner cred never reaches the served app)', () => {
  const block = serviceBlock(compose, 'server')
  assert.match(
    block,
    /^ {6}POSTGRES_PASSWORD: ""/m,
    'server.environment must set POSTGRES_PASSWORD: "" to override the env_file-injected owner secret',
  )
})
