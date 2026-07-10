#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// 3ngram CLI entrypoint — a THIN command layer over @3ngram/sdk (docs/concepts/architecture.mdx one
// core, N transports). The CLI is a client of the SDK exactly as the SDK is a
// client of REST; it imports @3ngram/sdk + @3ngram/schema ONLY (never core/db).
// This file wires the real process (argv, env, stdout/stderr, SDK client) into
// the injectable run() and sets the exit code — all logic lives behind that seam.

import { readFileSync } from 'node:fs'
import { ThreengramClient } from '@3ngram/sdk'
import type { Io } from './io.js'
import { run } from './run.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

const io: Io = {
  version: packageJson.version,
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  makeClient: (config) => new ThreengramClient(config),
}

run(process.argv.slice(2), io)
  .then((code) => {
    process.exitCode = code
  })
  .catch(() => {
    process.exitCode = 1
  })
