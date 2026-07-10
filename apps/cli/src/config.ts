// SPDX-License-Identifier: Apache-2.0
// CONFIG resolution is the CLI's job (the SDK takes EXPLICIT config only, by
// design — client.ts: "Config is EXPLICIT only ... that is the CLI's job").
// baseUrl + apiKey resolve from flags --base-url/--api-key OVERRIDING the env
// vars THREENGRAM_BASE_URL/THREENGRAM_API_KEY. A missing value is a typed
// failure the caller maps to a clear stderr line + non-zero exit — and the api
// key is NEVER echoed.

import type { ThreengramClientConfig } from '@3ngram/sdk'

/** Env var read for the REST origin when --base-url is absent. */
export const BASE_URL_ENV = 'THREENGRAM_BASE_URL'
/** Env var read for the API key when --api-key is absent. */
export const API_KEY_ENV = 'THREENGRAM_API_KEY'

/** Flag overrides parsed from argv (either may be absent). */
export interface ConfigFlags {
  baseUrl?: string | undefined
  apiKey?: string | undefined
}

/** A resolution failure: which setting is missing, for a clear message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Resolve the client config: a flag wins over its env var; a missing value (after
 * both sources) raises {@link ConfigError} naming the flag AND env var so the user
 * can fix it. The api key value is never included in any message.
 */
export function resolveConfig(
  flags: ConfigFlags,
  env: Record<string, string | undefined>,
): ThreengramClientConfig {
  const baseUrl = pick(flags.baseUrl, env[BASE_URL_ENV])
  if (baseUrl === undefined) {
    throw new ConfigError(`missing base URL: pass --base-url or set ${BASE_URL_ENV}`)
  }
  const apiKey = pick(flags.apiKey, env[API_KEY_ENV])
  if (apiKey === undefined) {
    throw new ConfigError(`missing API key: pass --api-key or set ${API_KEY_ENV}`)
  }
  return { baseUrl, apiKey }
}

/** Flag over env over undefined; an empty/whitespace string counts as absent. */
function pick(flag: string | undefined, fromEnv: string | undefined): string | undefined {
  const flagValue = flag?.trim()
  if (flagValue !== undefined && flagValue !== '') return flagValue
  const envValue = fromEnv?.trim()
  if (envValue !== undefined && envValue !== '') return envValue
  return undefined
}
