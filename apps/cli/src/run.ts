// SPDX-License-Identifier: Apache-2.0
// The injectable entrypoint: `run(argv, io)` parses the command and maps every
// failure to a friendly stderr line + a non-zero exit code, NEVER a stack trace
// and NEVER the api key. Tests call run() with a stub client + captured Io (no
// network, no process) — mirroring the SDK's FetchLike injection seam.

import { ThreengramApiError, ThreengramNetworkError } from '@3ngram/sdk'
import { runCommand, UsageError } from './commands.js'
import { ConfigError } from './config.js'
import type { Io } from './io.js'
import { CLI_COMMANDS } from './reference.js'

/** The usage banner printed for a missing/unknown command or a bad-args failure. */
const USAGE = [
  'usage: 3ngram <command> [options]',
  '',
  'commands:',
  ...CLI_COMMANDS.map((command) => `  ${command.usage}`),
  '',
  'global:  --base-url <url> --api-key <key> --json --version',
  `env:     ${'THREENGRAM_BASE_URL'} ${'THREENGRAM_API_KEY'} (flags override)`,
].join('\n')

/**
 * Parse argv and run the command. Returns the process exit code: 0 on success,
 * non-zero on any failure. No exception escapes — each is mapped to a stderr line.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v') {
    io.stdout(io.version)
    return 0
  }
  if (command === undefined || command === '--help' || command === '-h') {
    io.stderr(USAGE)
    return command === undefined ? 1 : 0
  }
  try {
    await runCommand(command, rest, io)
    return 0
  } catch (error) {
    return handleError(error, io)
  }
}

/** Map a thrown error to a friendly stderr line + non-zero exit (no key, no stack). */
function handleError(error: unknown, io: Io): number {
  if (error instanceof UsageError) {
    io.stderr(`error: ${error.message}`)
    io.stderr(USAGE)
    return 2
  }
  if (error instanceof ConfigError) {
    io.stderr(`error: ${error.message}`)
    return 2
  }
  if (error instanceof ThreengramApiError) {
    io.stderr(`error: the 3ngram server rejected the request (${error.status} ${error.reason})`)
    return 1
  }
  if (error instanceof ThreengramNetworkError) {
    io.stderr('error: could not reach the 3ngram server (check --base-url and connectivity)')
    return 1
  }
  io.stderr(`error: ${describeUnknown(error)}`)
  return 1
}

/** A safe message for an unexpected error — never leaks more than the message. */
function describeUnknown(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'unexpected failure'
}
