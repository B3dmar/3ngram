// SPDX-License-Identifier: Apache-2.0

// Engine-kit tests for the panel, run locally with `claude plugin test
// plugins/3ngram` (the CLI is not in the lockfile, so CI runs the pure-logic
// specs under spec/ instead; these are review-enforced). Every `$` call the
// plugin makes is answered beneath it here, so a call to anything not
// answered (the network, an MCP server, the file system, the store) would
// fail the test that triggered it; the forbidden nouns are also recorded
// explicitly.

import type { On } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'
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

type Answer = {
  stdout?: string
  stderr?: string
  throws?: string
  wait?: Promise<void>
  hang?: boolean
}

// fire starts work the test does not await here, without leaving a promise
// floating unhandled.
function fire(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

function showEnvelope(fingerprint: string): string {
  return JSON.stringify({
    contract: '3ngram-hook.commitments.v1',
    operation: 'show',
    ok: true,
    binary: '3ngram-hook test',
    context: context(fingerprint),
    commitment: {
      memoryId: '00000000-0000-4000-8000-a00000000001',
      topic: TOPIC,
      content: 'Full commitment text',
      scope: 'work',
      project: 'demo',
      filing: 'project',
      status: 'active',
      commitmentStatus: 'open',
      current: true,
      tags: [],
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
    source: {
      createdBy: 'user_mcp',
      createdAt: '2026-10-01T00:00:00.000Z',
      session: null,
      sessionReason: 'not_exposed',
    },
    evidence: {
      verdict: 'none_found',
      items: [],
      inspected: { proposals: null, history: null },
      hiddenOutsideSelector: 0,
      unverifiedPartners: 0,
    },
  })
}

// world answers every `$` call the plugin makes, and records the commands it
// runs and anything it must never touch.
function world(
  on: On,
  answer: (argv: string[]) => Answer,
  opts: { cwdThrows?: boolean; surfaces?: string[] } = {},
) {
  const spawned: string[][] = []
  // Each spawn the plugin ended early (Cancel, the ceiling) by returning it.
  const returned: string[][] = []
  const holds: (() => void)[] = []
  const forbidden: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'test' }) as never)
  on('session.attach', async (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', async (_$, e) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [...(opts.surfaces ?? ['terminal'])] }) as never)
  on('classic.SessionStart', async () => ({}) as never)
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
    if (a.hang) {
      // A child that never answers. The kit has no timers, so it waits on a
      // hold the test releases; each release lets it write one byte, which is
      // where a stream the plugin returned in the meantime ends.
      try {
        for (;;) {
          await new Promise<void>((resolve) => holds.push(resolve))
          yield { stream: 'stderr' as const, text: ' ' }
        }
      } finally {
        returned.push(argv)
      }
    }
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
  return { spawned, returned, holds, forbidden, statuses, clock }
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

type Pane = Mounted<'terminal' | 'desktop', 'Pane'>

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
  test('a key swap is caught by the probe before the read: old rows never show during it', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    // The context the probe sees: the old key until it is swapped.
    let current = FP_A
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(current) }
      reads++
      if (reads === 1) return { stdout: listEnvelope(FP_A) }
      return {
        wait: new Promise<void>((r) => {
          release = r
        }),
        stdout: listEnvelope(FP_B, 'Read under the new key'),
      }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    expect(await textOf(ui)).toContain(TOPIC)
    current = FP_B
    await w.clock.advance(5 * 60_000)
    // The second read is still running, and the old rows are already gone.
    expect(await textOf(ui)).not.toContain(TOPIC)
    release()
    await w.clock.advance(1)
    expect(await textOf(ui)).toContain('Read under the new key')
  })

  test('rows hide while the pre-refresh probe runs, and return when it confirms', async ($, on) => {
    let release: () => void = () => undefined
    let probes = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'context') {
        // The second probe is the one before the periodic read; the first
        // follows the startup read and answers at once.
        if (++probes !== 2) return { stdout: contextEnvelope(FP_A) }
        return {
          wait: new Promise<void>((r) => {
            release = r
          }),
          stdout: contextEnvelope(FP_A),
        }
      }
      return { stdout: listEnvelope(FP_A) }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    expect(await textOf(ui)).toContain(TOPIC)
    await w.clock.advance(5 * 60_000)
    // The probe is still running: nothing read under the old context shows.
    expect(probes).toBe(2)
    expect(await textOf(ui)).not.toContain(TOPIC)
    release()
    await w.clock.advance(1)
    expect(await textOf(ui)).toContain(TOPIC)
  })

  test('a key rotated during a read that fails without an answer: the probe disagrees, rows clear', async ($, on) => {
    let reads = 0
    let probes = 0
    const w = world(on, (argv) => {
      // The probes after the startup read and before the next one see the old
      // key; it is rotated while that read runs.
      if (argv[2] === 'context') return { stdout: contextEnvelope(++probes <= 2 ? FP_A : FP_B) }
      return ++reads === 1 ? { stdout: listEnvelope(FP_A) } : {}
    })
    await start($, w.clock)
    const ui = await mountPane($)
    expect(await textOf(ui)).toContain(TOPIC)
    await w.clock.advance(5 * 60_000)
    const text = await textOf(ui)
    expect(text).not.toContain(TOPIC)
    expect(text).toContain('could not be confirmed')
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

  test('a key rotated while a list read runs never shows that read', async ($, on) => {
    let current = FP_A
    let release: () => void = () => undefined
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(current) }
      reads++
      if (reads === 1) return { stdout: listEnvelope(FP_A) }
      if (reads === 2)
        return {
          wait: new Promise<void>((r) => {
            release = r
          }),
          stdout: listEnvelope(FP_A, 'Read under the old key'),
        }
      return { stdout: listEnvelope(FP_B, 'Read under the new key') }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    fire(ui.press({ key: 'refresh' }))
    await w.clock.advance(1)
    // The probe before the read confirmed the old key; it is rotated now,
    // while the read still runs under it.
    current = FP_B
    release()
    await w.clock.advance(1)
    await w.clock.advance(1)
    const text = await textOf(ui)
    expect(text).not.toContain('Read under the old key')
    expect(text).toContain('Read under the new key')
  })

  test('a probe that cannot answer after a read does not loop', async ($, on) => {
    let probes = 0
    const w = world(on, (argv) =>
      argv[2] === 'context'
        ? ++probes === 1
          ? { stdout: contextEnvelope(FP_A) }
          : {}
        : { stdout: listEnvelope(FP_A) },
    )
    await start($, w.clock)
    const lists = () => w.spawned.filter((argv) => argv[2] === 'list').length
    await w.clock.advance(5 * 60_000)
    await w.clock.advance(1)
    await w.clock.advance(1)
    // The periodic read ran once; the unanswered probe after it re-ran
    // nothing, and the rows did not survive it.
    expect(lists()).toBe(2)
    expect(await textOf(await mountPane($))).not.toContain(TOPIC)
  })

  test('an error envelope from another fingerprint clears the rows with no extra probe', async ($, on) => {
    let reads = 0
    const w = world(on, (argv) =>
      argv[2] === 'list'
        ? { stdout: ++reads === 1 ? listEnvelope(FP_A) : errorEnvelope('unavailable', FP_B) }
        : { stdout: contextEnvelope(FP_A) },
    )
    await start($, w.clock)
    await w.clock.advance(5 * 60_000)
    expect(await textOf(await mountPane($))).not.toContain(TOPIC)
    // One probe after the first read and one before the second; none after
    // the second, since the envelope named its own context.
    expect(w.spawned.filter((argv) => argv[2] === 'context').length).toBe(2)
  })
})

describe('cancellation and lifecycle', () => {
  test('cancel stops the read; a key change meanwhile clears the rows', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    let probes = 0
    const w = world(on, (argv) => {
      // Old key for the probes after the startup read and before the next
      // read; rotated while that read runs.
      if (argv[2] === 'context') return { stdout: contextEnvelope(++probes <= 2 ? FP_A : FP_B) }
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
    fire(ui.press({ key: 'refresh' }))
    await w.clock.advance(1)
    // The pre-read probe confirmed the context, so the rows show while it runs.
    expect(await textOf(ui)).toContain(TOPIC)
    await ui.press({ key: 'cancel' })
    release()
    await w.clock.advance(1)
    const text = await textOf(ui)
    expect(text).not.toContain(TOPIC)
    expect(text).toContain('The refresh was cancelled.')
    expect(text).toContain('could not be confirmed')
  })

  test('cancel under the same context keeps the rows, marked stale', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(FP_A) }
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
    fire(ui.press({ key: 'refresh' }))
    await w.clock.advance(1)
    await ui.press({ key: 'cancel' })
    release()
    await w.clock.advance(1)
    const text = await textOf(ui)
    expect(text).toContain(TOPIC)
    expect(text).toContain('STALE since')
  })

  test('a read that hangs is ended at the ceiling and shown as a timeout', async ($, on) => {
    const w = world(on, () => ({ hang: true }))
    await start($, w.clock)
    await w.clock.advance(13_000)
    for (const release of w.holds.splice(0)) release()
    await w.clock.advance(1)
    expect(await textOf(await mountPane($))).toContain('The read timed out.')
    expect(w.returned.length).toBe(1)
  })

  test('a refresh asked for during a read runs once that read ends', async ($, on) => {
    let release: () => void = () => undefined
    let reads = 0
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(FP_A) }
      reads++
      if (reads === 1)
        return {
          wait: new Promise<void>((r) => {
            release = r
          }),
          stdout: listEnvelope(FP_A),
        }
      return { stdout: listEnvelope(FP_A, 'The queued read') }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    fire(ui.press({ key: 'refresh' }))
    release()
    await w.clock.advance(1)
    expect(await textOf(ui)).toContain('The queued read')
  })

  test('an open detail hides with the rows when a read fails, until the context is confirmed', async ($, on) => {
    let reads = 0
    let release: () => void = () => undefined
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(FP_A) }
      if (argv[2] === 'show') return { stdout: showEnvelope(FP_A) }
      reads++
      if (reads === 1) return { stdout: listEnvelope(FP_A) }
      return {
        wait: new Promise<void>((r) => {
          release = r
        }),
      }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    await ui.press({ key: 'open-0-0' })
    expect(await textOf(ui)).toContain('Full commitment text')
    fire(ui.press({ key: 'back' }).then(() => ui.press({ key: 'open-0-0' })))
    await w.clock.advance(5 * 60_000)
    release()
    await w.clock.advance(1)
    // The read failed without an answer; the rows return as stale, the
    // detail does not.
    const text = await textOf(ui)
    expect(text).not.toContain('Full commitment text')
    expect(text).toContain('STALE since')
  })

  test('/clear reads again once the state is reset, not before', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }))
    await start($, w.clock)
    const lists = () => w.spawned.filter((argv) => argv[2] === 'list').length
    const before = lists()
    // session.end comes before core resets $.state: a read started here
    // would be erased by the reset, so none starts.
    await $.session.end({ reason: 'clear' } as never)
    await w.clock.advance(1)
    expect(lists()).toBe(before)
    // classic.SessionStart fires after the reset; the fresh read starts there.
    await $.classic.SessionStart({ source: 'clear' } as never)
    await w.clock.advance(1)
    expect(lists()).toBe(before + 1)
    expect(await textOf(await mountPane($))).toContain(TOPIC)
  })

  test('a resume at launch reads once, not twice', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }))
    await start($, w.clock)
    const before = w.spawned.length
    // No session.end came before it: this is --resume at launch, whose state
    // is fresh, and the startup read already covers it.
    await $.classic.SessionStart({ source: 'resume' } as never)
    await w.clock.advance(1)
    expect(w.spawned.length).toBe(before)
  })

  test('/branch (source fork) reads again; startup and compaction do not', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }))
    await start($, w.clock)
    const lists = () => w.spawned.filter((argv) => argv[2] === 'list').length
    const before = lists()
    await $.classic.SessionStart({ source: 'compact' } as never)
    await $.classic.SessionStart({ source: 'startup' } as never)
    await w.clock.advance(1)
    expect(lists()).toBe(before)
    await $.classic.SessionStart({ source: 'fork' } as never)
    await w.clock.advance(1)
    expect(lists()).toBe(before + 1)
  })

  test('the last client detaching stops the background reads', async ($, on) => {
    const roster: string[] = []
    const w = world(
      on,
      (argv) =>
        argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
      { surfaces: roster },
    )
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    roster.push('mobile')
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await w.clock.advance(1)
    const lists = () => w.spawned.filter((argv) => argv[2] === 'list').length
    expect(lists()).toBe(1)
    roster.length = 0
    await $.session.detach({ surface: 'mobile', clientId: 'mobile:default', reason: 'detach' })
    await w.clock.advance(15 * 60_000)
    expect(lists()).toBe(1)
    // A later client arms them again.
    roster.push('mobile')
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:second' })
    await w.clock.advance(1)
    expect(lists()).toBe(2)
  })

  test('a refresh that clears an open detail stops its read', async ($, on) => {
    let fingerprint = FP_A
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(fingerprint) }
      if (argv[2] === 'show') return { hang: true }
      return { stdout: listEnvelope(fingerprint) }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    fire(ui.press({ key: 'open-0-0' }))
    await w.clock.advance(1)
    expect(w.spawned.some((argv) => argv[2] === 'show')).toBe(true)
    // The key changed: the refresh's context check answers another
    // fingerprint and clears the rows and the detail. Asked from the command,
    // well inside the read ceiling, so only the clear can end the child.
    fingerprint = FP_B
    await $.command.run({ command: 'commitments', args: '' } as never)
    await w.clock.advance(1)
    for (const release of w.holds.splice(0)) release()
    await w.clock.advance(1)
    expect(w.returned.some((argv) => argv[2] === 'show')).toBe(true)
    expect(await textOf(ui)).not.toContain('Full commitment text')
  })

  test('a session that draws nowhere reads nothing until a client attaches', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
    )
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await w.clock.advance(15 * 60_000)
    expect(w.spawned.length).toBe(0)
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await w.clock.advance(1)
    expect(w.spawned.filter((argv) => argv[2] === 'list').length).toBe(1)
  })

  test('a reload after a client attached keeps the background reads, without doubling them', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
    )
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:second' })
    await w.clock.advance(1)
    // The reload: the attached client is the surface it starts with.
    await $.session.start({ cwd: '/repo', surface: 'mobile', isInteractive: false })
    await w.clock.advance(15 * 60_000)
    const lists = w.spawned.filter((argv) => argv[2] === 'list').length
    // One read at attach, one after the reload, then one per five minutes.
    expect(lists).toBe(5)
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

  test('a second session.start in the same environment does not stack timers', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'list' ? { stdout: listEnvelope(FP_A) } : { stdout: contextEnvelope(FP_A) },
    )
    await start($, w.clock)
    await start($, w.clock)
    await w.clock.advance(5 * 60_000)
    // One read per start, then ONE per interval.
    expect(w.spawned.filter((argv) => argv[2] === 'list').length).toBe(3)
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

  test('a reload during a detail read closes the detail instead of leaving it loading', async ($, on) => {
    let release: () => void = () => undefined
    const w = world(on, (argv) => {
      if (argv[2] === 'context') return { stdout: contextEnvelope(FP_A) }
      if (argv[2] === 'show')
        return {
          wait: new Promise<void>((r) => {
            release = r
          }),
          stdout: showEnvelope(FP_A),
        }
      return { stdout: listEnvelope(FP_A) }
    })
    await start($, w.clock)
    const ui = await mountPane($)
    fire(ui.press({ key: 'open-0-0' }))
    await w.clock.advance(1)
    // A reload runs session.start again with the state the host kept.
    await start($, w.clock)
    release()
    await w.clock.advance(1)
    const text = await textOf(ui)
    expect(text).not.toContain('Loading')
    expect(text).toContain(TOPIC)
  })

  test('GitHub lookups are on by default and reach the binary', async ($, on) => {
    const w = world(on, (argv) =>
      argv[2] === 'context' ? { stdout: contextEnvelope(FP_A) } : { stdout: listEnvelope(FP_A) },
    )
    await start($, w.clock)
    const before = w.spawned.filter((argv) => argv[2] === 'list')
    expect(before.at(-1)).toContain('--github')
    expect(before.length).toBe(1)
  })

  test('a refresh that throws outside its own handling is shown, not swallowed', async ($, on) => {
    const w = world(on, () => ({ stdout: listEnvelope(FP_A) }), { cwdThrows: true })
    await start($, w.clock)
    expect(await textOf(await mountPane($))).toContain('ERROR')
  })
})
