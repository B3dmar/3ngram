// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface } from 'claude-code'
import type { Selection } from './lib/argv.ts'
import { contextArgv, isAllowedArgv, refusalKind } from './lib/argv.ts'
import { parseEnvelope } from './lib/contract.ts'
import { classifyEmptyOutput, classifySpawnError } from './lib/process.ts'
import type { FailureKind } from './lib/state.ts'

// The one place the panel starts a child: an allow-listed `3ngram-hook
// commitments` command (lib/argv.ts) under a hard ceiling. It holds no state;
// the reads that call it (reads.ts) keep the handle that stops it.

export const PROCESS_CEILING_MS = 12_000
const PROBE_CEILING_MS = 3_000
const MAX_STDOUT = 8 * 1024 * 1024

type RunOutcome = { kind: 'output'; stdout: string } | { kind: 'failure'; failure: FailureKind }

// runHook spawns one allow-listed command and collects its stdout under a
// hard ceiling. onStart receives the function that ends the child early.
export async function runHook(
  $: EngineInterface,
  argv: string[],
  ceilingMs: number,
  onStart?: (stop: () => void) => void,
): Promise<RunOutcome> {
  if (!isAllowedArgv(argv)) return { kind: 'failure', failure: refusalKind(argv) }
  let stdout = ''
  let stderr = ''
  let stopped: 'timeout' | 'cancelled' | 'crash' | null = null
  const stream = $.process.spawn({ argv })
  const stop = (why: 'timeout' | 'cancelled' | 'crash') => {
    stopped ??= why
    // Returning the stream ends the child (SIGTERM).
    stream.return(undefined as never).catch(() => {
      $.ui.log('3ngram: stopping a child failed', { to: 'debug' })
    })
  }
  const timer = $.clock.after(ceilingMs, () => stop('timeout'))
  onStart?.(() => stop('cancelled'))
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else stderr = (stderr + chunk.text).slice(-4096)
      if (stdout.length > MAX_STDOUT) stop('crash')
    }
  } catch (err) {
    if (stopped) return { kind: 'failure', failure: stopped }
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'failure', failure: classifySpawnError(message) }
  } finally {
    timer.cancel()
  }
  if (stopped) return { kind: 'failure', failure: stopped }
  if (stdout.trim() === '') return { kind: 'failure', failure: classifyEmptyOutput(stderr) }
  return { kind: 'output', stdout }
}

// probe runs `commitments context`, which makes no network call, and answers
// the fingerprint of the context a read would use now, or null.
export async function probe($: EngineInterface, sel: Selection): Promise<string | null> {
  const outcome = await runHook($, contextArgv(sel), PROBE_CEILING_MS)
  if (outcome.kind !== 'output') return null
  const parsed = parseEnvelope(outcome.stdout)
  return parsed.ok && parsed.envelope.ok ? parsed.envelope.context.fingerprint : null
}
