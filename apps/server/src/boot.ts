// SPDX-License-Identifier: Apache-2.0
// Shared server bootstrap. The ONE fail-closed boot sequence used by
// BOTH composition roots — the Apache entry (src/index.ts) and the private
// repo's entrypoint — so the two can never drift.
//
// Load-order contract (config/otel.ts): Sentry's OTel auto-instrumentation MUST
// be initialized before express/http load. Static imports are hoisted ahead of
// any code, so this module static-imports ONLY the instrumentation +
// config/llm setup (none of which pulls express/OTel's express graph), and the
// app — whose module graph pulls in express — is loaded via DYNAMIC import after
// initObservability() runs. Importing this module has no side effects; the boot
// sequence runs only when bootstrap() is called.
import type { Server } from 'node:http'
import { loadEnv, loadOAuthConfig, log } from '@3ngram/config'
import { initObservability } from '@3ngram/config/otel'
// Zero-dep, fetch-based package — safe to static-import (no express/OTel graph,
// so it does not violate the load-order contract above).
import { assertMeteredOperationsRegistered } from '@3ngram/llm'
import type { Extension } from './composition/extension.js'

/**
 * The private repo supplies its Extension as a LAZY factory, not a value, so the
 * express/pg module graph it pulls in (its router → @3ngram/db) loads INSIDE
 * bootstrap() — after initObservability() — honoring the OTel load-order contract
 * (a value would force the import eagerly at the call site, before instrumentation,
 * dropping HTTP/pg spans under SENTRY_DSN). A plain value is still accepted for
 * backward compatibility.
 */
export type ExtensionFactory = () => Extension | Promise<Extension>

export interface BootstrapOptions {
  /**
   * Composition seam. The private repo passes its real Extension (as a factory —
   * see {@link ExtensionFactory}); the Apache entry passes nothing (no-op default).
   * createApp derives every other option (gateway, limiters, redis) from env, so
   * the boot path only threads the extension.
   */
  extension?: Extension | ExtensionFactory
}

/** Resolve the extension seam: invoke a factory (after initObservability) or pass a value through. */
async function resolveExtension(
  extension: Extension | ExtensionFactory | undefined,
): Promise<Extension | undefined> {
  if (typeof extension === 'function') return extension()
  return extension
}

/**
 * Run the fail-closed boot sequence and start the server:
 *  1. initObservability() FIRST (before express loads — load-order contract).
 *  2. loadEnv() — refuse-by-construction: a misconfigured process dies at boot.
 *  3. assertMeteredOperationsRegistered() — every metered LLM op has a maxCost;
 *     a missing entry is a loud startup failure, not a runtime
 *     surprise.
 *  4. OAuth key validation (when configured) — config validates JWK SHAPE,
 *     assertSigningKeysUsable validates KEY MATERIAL as RS256 (an
 *     unusable key kills the process before the first request). Dynamic import
 *     keeps core's graph behind initObservability, like the app graph below.
 *  5. Dynamic-import createApp (express graph) and listen; wire signal handlers.
 *
 * Reused verbatim by both entrypoints so hosted cloud gets the SAME fail-closed
 * env/key checks and OTel/request instrumentation as the Apache server.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Server> {
  initObservability()
  const env = loadEnv()
  assertMeteredOperationsRegistered()
  if (env.BASE_URL !== undefined && env.OAUTH_JWKS !== undefined) {
    const { assertSigningKeysUsable } = await import('@3ngram/core/auth')
    await assertSigningKeysUsable(loadOAuthConfig().keys)
  }

  // Resolve the extension AFTER initObservability(): a factory pulls its
  // express/pg graph in here, behind the OTel load-order contract.
  const extension = await resolveExtension(options.extension)
  const { createApp } = await import('./app.js')
  // Pass `extension` only when present (exactOptionalPropertyTypes): an explicit
  // `undefined` is not assignable to the optional AppOptions.extension.
  const server = createApp(extension === undefined ? {} : { extension }).listen(env.PORT, () => {
    log().info({ port: env.PORT }, 'server: listening')
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log().info({ signal }, 'server: shutting down')
      server.close(() => process.exit(0))
    })
  }
  return server
}
