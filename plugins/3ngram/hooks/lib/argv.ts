// SPDX-License-Identifier: Apache-2.0

// The only commands the panel runs. Every spawn goes through these builders,
// and isAllowedArgv is checked before each one, so the panel can only ever
// start the read-only `3ngram-hook commitments` subcommands.

export const HOOK_BINARY = '3ngram-hook'

// Selection is what the panel reads under: the session's directory (from
// which the binary derives the project), and the plugin's options.
export type Selection = {
  cwd: string
  scope: string
  includeUnscoped: boolean
  github: boolean
}

function selectionFlags(sel: Selection): string[] {
  const flags = ['--json', '--cwd', sel.cwd]
  if (sel.scope !== '') flags.push('--scope', sel.scope)
  if (sel.includeUnscoped) flags.push('--include-unscoped')
  return flags
}

export function contextArgv(sel: Selection): string[] {
  return [HOOK_BINARY, 'commitments', 'context', ...selectionFlags(sel)]
}

export function listArgv(sel: Selection): string[] {
  const argv = [HOOK_BINARY, 'commitments', 'list', ...selectionFlags(sel)]
  if (sel.github) argv.push('--github')
  return argv
}

export function showArgv(sel: Selection, memoryId: string, fingerprint: string): string[] {
  const argv = [
    HOOK_BINARY,
    'commitments',
    'show',
    memoryId,
    '--expect-fingerprint',
    fingerprint,
    ...selectionFlags(sel),
  ]
  if (sel.github) argv.push('--github')
  return argv
}

// selectionKey identifies what a refresh asks for. Two refreshes with the same
// key may keep each other's rows while one is in flight; a different key
// clears them before anything is read.
export function selectionKey(sel: Selection): string {
  return JSON.stringify([sel.cwd, sel.scope, sel.includeUnscoped])
}

const OPERATIONS = new Set(['context', 'list', 'show'])
const VALUE_FLAGS = new Set(['--cwd', '--scope', '--expect-fingerprint'])
const BARE_FLAGS = new Set(['--json', '--include-unscoped', '--github'])

// isAllowedArgv accepts exactly the shapes the builders produce: the hook
// binary, `commitments`, one read operation (show with its id), and only the
// read flags. A value can never smuggle a flag in, since every value position
// is fixed by the flag before it.
export function isAllowedArgv(argv: readonly string[]): boolean {
  if (argv[0] !== HOOK_BINARY || argv[1] !== 'commitments') return false
  const operation = argv[2]
  if (operation === undefined || !OPERATIONS.has(operation)) return false
  let i = 3
  if (operation === 'show') {
    const id = argv[3]
    if (id === undefined || id === '' || id.startsWith('-')) return false
    i = 4
  }
  for (; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (BARE_FLAGS.has(arg)) continue
    if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
      i++
      continue
    }
    return false
  }
  return true
}
