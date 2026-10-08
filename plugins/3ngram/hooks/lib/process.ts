// SPDX-License-Identifier: Apache-2.0

import type { FailureKind } from './state.ts'

// How a spawn that produced no envelope failed, from what the engine and the
// binary said. Kept here, pure, so the exact engine wording is pinned by a
// spec (the engine-kit tests cannot reproduce it: the kit sanitizes errors a
// test hook throws).

// classifySpawnError reads the error a spawn rejected with. The engine's
// wording for a binary that is not on PATH is, for example,
//   3ngram: $.process.spawn(3ngram-hook) failed to start: ENOENT:
//   Executable not found in $PATH: "3ngram-hook"
// "failed to start" alone is not enough: a binary that is on PATH but cannot
// run (EACCES, a wrong-architecture ENOEXEC) fails to start too, and telling
// that person to install the binary would be wrong.
export function classifySpawnError(message: string): FailureKind {
  return /ENOENT|not found in \$PATH/i.test(message) ? 'missing_binary' : 'crash'
}

// classifyEmptyOutput reads stderr when the binary exited without printing an
// envelope. A binary from before the commitments command answers with
// `unknown command: commitments`.
export function classifyEmptyOutput(stderr: string): FailureKind {
  return /unknown command: commitments/.test(stderr) ? 'too_old' : 'crash'
}
