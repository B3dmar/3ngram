// SPDX-License-Identifier: Apache-2.0

// Engine-kit tests for the panel, run locally with `claude plugin test
// plugins/3ngram` (the CLI is not in the lockfile, so CI runs the pure-logic
// specs under spec/ instead; these are review-enforced). Every `$` call the
// plugin makes is answered beneath it here, so a call to anything not
// answered (the network, an MCP server, the file system, the store) would
// fail the test that triggered it; the forbidden nouns are also recorded
// explicitly.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = '3ngram'
const PANE = '3ngram-commitments'
const FP_A = 'aaaaaaaaaaaaaaaa'
const FP_B = 'bbbbbbbbbbbbbbbb'
const TOPIC = 'Ship the commitment panel'

function context(fingerprint: string) {
  return {
    fingerprint,
    apiHost: 'api.example.test',
    account: { id: 'u1', email: 'owner@example.test' },
    project: { name: 'demo', source: 'git-remote' },
    requested: { kind: 'project', project: 'demo' },
    effective: { kind: 'project', project: 'demo' },
  }
}

function listEnvelope(fingerprint: string, topic = TOPIC): string {
  return JSON.stringify({
    contract: '3ngram-hook.commitments.v1',
    operation: 'list',
    ok: true,
    binary: '3ngram-hook test',
    context: context(fingerprint),
    counts: { openOrWaiting: 1, overdue: 0, returned: 1, changedDuringRead: 0 },
    commitments: [
      {
        memoryId: '00000000-0000-4000-8000-a00000000001',
        commitmentId: '00000000-0000-4000-8000-c00000000001',
        topic,
        status: 'open',
        dueAt: null,
        overdue: false,
        filing: 'project',
        ownership: { value: 'unclear', reason: 'owner_not_exposed' },
      },
    ],
    missing: ['owner', 'sourceSession'],
  })
}

function contextEnvelope(fingerprint: string): string {
  return JSON.stringify({
    contract: '3ngram-hook.commitments.v1',
    operation: 'context',
    ok: true,
    binary: '3ngram-hook test',
    context: context(fingerprint),
  })
}

function errorEnvelope(kind: string, fingerprint: string): string {
  return JSON.stringify({
    contract: '3ngram-hook.commitments.v1',
    operation: 'list',
    ok: false,
    binary: '3ngram-hook test',
    context: context(fingerprint),
    error: { kind, route: 'briefing', status: 401 },
  })
}

type Answer = { stdout?: string; stderr?: string; throws?: string; wait?: Promise<void> }

// world answers every `$` call the plugin makes, and records the commands it
// runs and anything it must never touch.
function world(on: On, answer: (argv: string[]) => Answer, opts: { cwdThrows?: boolean } = {}) {
  const spawned: string[][] = []
  const forbidden: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'test' }) as never)
  on('session.cwd', async () => {
    if (opts.cwdThrows) throw new Error('cwd unavailable')
    return { value: '/repo' }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async (_$, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('process.spawn', async function* (_$, e) {
    const argv = [...e.argv]
    spawned.push(argv)
    const a = answer(argv)
    if (a.wait) await a.wait
    if (a.throws) throw new Error(a.throws)
    if (a.stdout) yield { stream: 'stdout' as const, text: a.stdout }
    if (a.stderr) yield { stream: 'stderr' as const, text: a.stderr }
    return { value: { code: a.stdout ? 0 : 1, signal: null } } as never
  })
  for (const noun of [
    'http.fetch',
    'mcp.call',
    'fs.write',
    'store.set',
    'store.delete',
    'env.set',
    'process.run',
  ] as const) {
    on(noun, async () => {
      forbidden.push(noun)
      return { deny: `${noun} is not allowed for the read-only panel` } as never
    })
  }
  return { spawned, forbidden, statuses, clock }
}

function paneProps() {
  return {
    title: '3ngram commitments',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }
}

// start raises session.start and lets the startup timer run its first read.
async function start($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
}

type Pane = Awaited<ReturnType<Engine['ui']['mount']>>

// mountPane draws the pane once per surface; textOf re-reads the drawing as
// it stands now.
async function mountPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<Pane> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: paneProps(),
  })
}

async function textOf(ui: Pane): Promise<string> {
  const found = await ui.findAll({})
  return found.map((el) => el.text).join('\n')
}

function isCommitmentsCommand(argv: string[]): boolean {
  return argv[0] === '3ngram-hook' && argv[1] === 'commitments'
}

describe('the read-only data path', () => {
  test('a session start reads the list and draws it on terminal and desktop', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
    )
    await start($, w.clock)
    for (const surface of ['terminal', 'desktop'] as const) {
      const text = await textOf(await mountPane($, surface))
      expect(text).toContain(TOPIC)
      expect(text).toContain('project demo (from the git remote)')
      expect(text).toContain('owner unclear (not recorded)')
    }
    expect(w.spawned.every(isCommitmentsCommand)).toBe(true)
    expect(w.forbidden).toEqual([])
    expect(w.statuses.at(-1)).toBe('3ngram: 1 open · 0 overdue')
  })

  test('the status line and the command reply never carry a topic', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }))
    await start($, w.clock)
    const reply = await $.command.run({ command: 'commitments', args: '' } as never)
    await w.clock.advance(1)
    expect(JSON.stringify(reply)).not.toContain(TOPIC)
    for (const status of w.statuses) expect(String(status)).not.toContain(TOPIC)
  })

  test('an auth failure is shown as such, with no rows', async ($, on) => {
    const w = world(on, () => ({ stdout: errorEnvelope('auth', FP_A) }))
    await start($, w.clock)
    const text = await textOf(await mountPane($))
    expect(text).toContain('The 3ngram API key was refused')
    expect(text).not.toContain(TOPIC)
  })

  // The engine's own "not on PATH" wording is pinned by spec/process.spec.ts;
  // the kit sanitizes a test hook's error, so here a failed start reads as
  // a crash. What matters at this level: an error, and no rows.
  test('a spawn that cannot start is an error with no rows', async ($, on) => {
    const w = world(on, () => ({
      throws:
        '3ngram: $.process.spawn(3ngram-hook) failed to start: ENOENT: Executable not found in $PATH',
    }))
    await start($, w.clock)
    const text = await textOf(await mountPane($))
    expect(text).toContain('ERROR')
    expect(text).not.toContain(TOPIC)
  })

  test('a binary without the commitments command is told apart', async ($, on) => {
    const w = world(on, () => ({ stderr: 'unknown command: commitments' }))
    await start($, w.clock)
    expect(await textOf(await mountPane($))).toContain('has no commitments command')
  })
})

describe('switching accounts cannot show the previous context', () => {
  test('a key change followed by a crash clears the rows once the probe disagrees', async ($, on) => {
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'list') return ++reads === 1 ? { stdout: listEnvelope(FP_A) } : {}
      return { stdout: contextEnvelope(FP_B) }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    expect(await textOf(ui)).toContain(TOPIC)
    await w.clock.advance(5 * 60_000)
    const text = await textOf(ui)
    expect(text).not.toContain(TOPIC)
    expect(text).toContain('could not be confirmed')
    expect(w.spawned.some((argv) => argv[2] === 'context')).toBe(true)
  })

  test('the same failure under the same context keeps the rows, marked stale', async ($, on) => {
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'list') return ++reads === 1 ? { stdout: listEnvelope(FP_A) } : {}
      return { stdout: contextEnvelope(FP_A) }
    })
    await start($, w.clock)
    await w.clock.advance(5 * 60_000)
    const text = await textOf(await mountPane($))
    expect(text).toContain(TOPIC)
    expect(text).toContain('STALE since')
  })

  test('an error envelope from another fingerprint clears the rows without a probe', async ($, on) => {
    let reads = 0
    const w = world(on, (argv) =>
      argv[2] === 'list'
        ? { stdout: ++reads === 1 ? listEnvelope(FP_A) : errorEnvelope('unavailable', FP_B) }
        : {},
    )
    await start($, w.clock)
    await w.clock.advance(5 * 60_000)
    expect(await textOf(await mountPane($))).not.toContain(TOPIC)
    expect(w.spawned.some((argv) => argv[2] === 'context')).toBe(false)
  })
})

describe('cancellation and lifecycle', () => {
  test('cancel stops the read; a key change meanwhile clears the rows', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] !== 'list') return { stdout: contextEnvelope(FP_B) }
      reads++
      if (reads === 1) return { stdout: listEnvelope(FP_A) }
      return {
        wait: new Promise<void>((r) => {
          release = r
        }),
        stdout: listEnvelope(FP_A),
      }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    void ui.press({ key: 'refresh' })
    await w.clock.advance(1)
    await ui.press({ key: 'cancel' })
    release()
    await w.clock.advance(1)
    const text = await textOf(ui)
    expect(text).not.toContain(TOPIC)
    expect(text).toContain('The refresh was cancelled.')
  })

  test('/clear clears everything and reads again', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }))
    await start($, w.clock)
    const before = w.spawned.length
    await $.session.end({ reason: 'clear' } as never)
    await w.clock.advance(1)
    expect(w.spawned.length).toBe(before + 1)
    expect(await textOf(await mountPane($))).toContain(TOPIC)
  })

  test('one session start keeps one refresh timer', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
    )
    await start($, w.clock)
    await w.clock.advance(15 * 60_000)
    // The first read, then one per five minutes: no duplicate intervals.
    expect(w.spawned.filter((argv) => argv[2] === 'list').length).toBe(4)
  })

  test('a reload during a read counts it as cancelled and reads again', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] !== 'list') return { stdout: contextEnvelope(FP_A) }
      reads++
      return reads === 1
        ? {
            wait: new Promise<void>((r) => {
              release = r
            }),
            stdout: listEnvelope(FP_A),
          }
        : { stdout: listEnvelope(FP_A, 'After the reload') }
    })
    await start($, w.clock)
    // A reload runs session.start again with the state the host kept.
    await start($, w.clock)
    release()
    await w.clock.advance(1)
    expect(await textOf(await mountPane($))).toContain('After the reload')
  })

  test('a refresh that throws outside its own handling is shown, not swallowed', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }), { cwdThrows: true })
    await start($, w.clock)
    expect(await textOf(await mountPane($))).toContain('ERROR')
  })
})
