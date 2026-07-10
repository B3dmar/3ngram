// SPDX-License-Identifier: Apache-2.0
// The CLI's injectable side-effect seam. The entrypoint and tests pass an `Io`
// so a test asserts on captured stdout/stderr/exit WITHOUT touching the real
// process — mirroring the SDK's FetchLike injection (packages/sdk/test).

import type { ThreengramClient, ThreengramClientConfig } from '@3ngram/sdk'

/** A sink for one output stream — a thin seam over `process.stdout.write`. */
export type WriteLine = (line: string) => void

/** Everything the CLI touches outside pure logic — all injectable for tests. */
export interface Io {
  /** Installed CLI package version, read from package.json by the process entrypoint. */
  version: string
  /** Environment for config resolution (defaults to `process.env`). */
  env: Record<string, string | undefined>
  /** Standard-output sink (human or `--json` payloads). */
  stdout: WriteLine
  /** Standard-error sink (usage, config, and error messages). */
  stderr: WriteLine
  /**
   * Build the SDK client from resolved config. Injectable so tests substitute a
   * stub client (no network); production constructs the real {@link ThreengramClient}.
   */
  makeClient: (config: ThreengramClientConfig) => ThreengramClient
}
