// SPDX-License-Identifier: Apache-2.0

import type { BriefingSummary } from './activity-briefing.ts'
import type { MemoryEntry, Observation } from './observe.ts'

// The session activity model: what the agent read and changed through 3ngram
// MCP tools in this session, folded from the calls the plugin observes
// (hooks/activity.ts reads each call, observe.ts parses it). Pure: no engine
// imports, the time passed in.
//
// - Everything is keyed by server, the MCP server's name as the tool name
//   spells it. Two servers can be two accounts, so their counts are never
//   merged and every call and memory carries its server.
// - The state is bounded: the last `calls` calls, at most `memories` distinct
//   memories and `servers` servers (ACTIVITY_LIMITS). The least recently seen
//   memory the agent only read goes first, so one it changed outlasts reads;
//   every eviction is counted on its server, so a count shown is a floor,
//   never a silent undercount. A call from a server past the bound is counted
//   in `ignored` alone.
// - Of a record's content it keeps only the topic, cut to TOPIC_LIMIT
//   characters: never a memory's content, a fact or a proposal's rationale.

export type ActivityLimits = { calls: number; memories: number; servers: number }
export const ACTIVITY_LIMITS: Readonly<ActivityLimits> = { calls: 200, memories: 500, servers: 16 }

export type CallKind = 'read' | 'write' | 'other'
// ok: answered and read (or a tool whose answer names no memory); error: the
// tool reported an error; denied: refused before or instead of running;
// unparsed: answered, but not in a shape this version reads.
export type CallOutcome = 'ok' | 'error' | 'denied' | 'unparsed'

// What a call did to one memory. revised: superseded by a revise (it was the
// predecessor); successor: written by a revise in place of another; moved:
// refiled in place; archived: taken out of the active set (revise archive, or
// a blocker resolve); resolved: its commitment or blocker settled by resolve;
// proposal_*: a review_proposals decision on a proposal naming it.
export type WriteAction =
  | 'remembered'
  | 'revised'
  | 'successor'
  | 'moved'
  | 'archived'
  | 'reaffirmed'
  | 'resolved'
  | 'status_changed'
  | 'proposal_applied'
  | 'proposal_rejected'

export type CommitmentStatus = 'open' | 'waiting' | 'resolved' | 'expired'
export type MemoryStatus = 'active' | 'archived'

export type ActivityCall = {
  // 1 for the session's first observed call, counting the ignored ones out.
  seq: number
  at: number
  server: string
  tool: string
  kind: CallKind
  outcome: CallOutcome
  // The subagent's or teammate's loop it ran in; absent on the main loop.
  agentId?: string
  // Records the result listed (hits, memories, facts, proposals, outcomes).
  returned: number
  // Distinct memories it recorded.
  memories: number
}

export type MemoryActivity = {
  server: string
  id: string
  // The last value a result reported; absent while none has.
  memoryType?: string
  topic?: string
  scope?: string
  // null: reported as filed without a project.
  project?: string | null
  status?: MemoryStatus
  commitmentStatus?: CommitmentStatus
  firstSeen: number
  lastSeen: number
  // The seq of the last call that listed or changed it.
  lastCall: number
  // Calls whose result listed it, and the read tools that did, first first.
  reads: number
  readVia: string[]
  // What the agent did to it, each once, in the order first done.
  actions: WriteAction[]
}

export type ServerActivity = {
  server: string
  firstAt: number
  lastAt: number
  // Every call observed, evicted ones included, then by kind and outcome.
  calls: number
  reads: number
  writes: number
  errors: number
  denied: number
  unparsed: number
  evictedCalls: number
  evictedMemories: number
  evictedWrites: number
  briefing?: BriefingSummary & { at: number }
}

export type ActivityWrite = MemoryEntry & { server: string; seq: number; at: number }

export type ActivityState = {
  // When the first call of the session was observed; null before one.
  startedAt: number | null
  seq: number
  // Oldest first.
  calls: ActivityCall[]
  writes: ActivityWrite[]
  // Least recently seen first.
  memories: MemoryActivity[]
  servers: ServerActivity[]
  ignored: number
}

export const initialActivity: ActivityState = {
  startedAt: null,
  seq: 0,
  calls: [],
  writes: [],
  memories: [],
  servers: [],
  ignored: 0,
}

export function fold(
  prev: ActivityState,
  seen: Observation,
  limits: ActivityLimits = ACTIVITY_LIMITS,
): ActivityState {
  const s = isActivityState(prev) ? prev : initialActivity
  const isKnown = s.servers.some((x) => x.server === seen.server)
  if (!isKnown && s.servers.length >= limits.servers) return { ...s, ignored: s.ignored + 1 }
  const seq = s.seq + 1
  const touched = touch(s.memories, seen, seq, limits.memories)
  const call: ActivityCall = {
    seq,
    at: seen.at,
    server: seen.server,
    tool: seen.tool,
    kind: seen.kind,
    outcome: seen.outcome,
    ...(seen.agentId === undefined ? {} : { agentId: seen.agentId }),
    returned: seen.returned,
    memories: touched.count,
  }
  const calls = [...s.calls, call]
  const dropped = calls.splice(0, Math.max(0, calls.length - limits.calls))
  const writes = [
    ...s.writes,
    ...seen.entries
      .filter((entry) => entry.via !== 'read' && entry.via !== 'proposal_rejected')
      .map((entry) => ({ ...entry, server: seen.server, seq, at: seen.at })),
  ]
  const droppedWrites = writes.splice(0, Math.max(0, writes.length - limits.calls))
  return {
    startedAt: s.startedAt ?? seen.at,
    seq,
    calls,
    writes,
    memories: touched.memories,
    servers: tally(s.servers, seen, dropped, touched.evicted, droppedWrites),
    ignored: s.ignored,
  }
}

function keyOf(server: string, id: string): string {
  // A tool name holds no newline, so no server name does either.
  return `${server}\n${id}`
}

type Touched = { memories: MemoryActivity[]; count: number; evicted: Map<string, number> }

function touch(
  prev: readonly MemoryActivity[],
  seen: Observation,
  seq: number,
  max: number,
): Touched {
  const byKey = new Map(prev.map((m) => [keyOf(m.server, m.id), m] as const))
  const mine = new Set<string>()
  for (const entry of seen.entries) {
    const key = keyOf(seen.server, entry.id)
    const next = merge(byKey.get(key), entry, seen, seq)
    // Deleting first moves it to the end: the map stays least recent first.
    byKey.delete(key)
    byKey.set(key, next)
    mine.add(key)
  }
  const evicted = new Map<string, number>()
  while (byKey.size > max) {
    const victim = oldestReadOnly(byKey) ?? byKey.keys().next().value
    if (victim === undefined) break
    const server = byKey.get(victim)?.server ?? seen.server
    byKey.delete(victim)
    evicted.set(server, (evicted.get(server) ?? 0) + 1)
  }
  return { memories: [...byKey.values()], count: mine.size, evicted }
}

function oldestReadOnly(byKey: ReadonlyMap<string, MemoryActivity>): string | undefined {
  for (const [key, m] of byKey) if (!wasChanged(m)) return key
  return undefined
}

function wasChanged(memory: MemoryActivity): boolean {
  return memory.actions.some((action) => action !== 'proposal_rejected')
}

function merge(
  held: MemoryActivity | undefined,
  entry: MemoryEntry,
  seen: Observation,
  seq: number,
): MemoryActivity {
  const base: MemoryActivity = held ?? {
    server: seen.server,
    id: entry.id,
    firstSeen: seen.at,
    lastSeen: seen.at,
    lastCall: seq,
    reads: 0,
    readVia: [],
    actions: [],
  }
  const { id: _id, via, ...reported } = entry
  const isRead = via === 'read'
  return {
    ...base,
    ...reported,
    lastSeen: seen.at,
    lastCall: seq,
    reads: base.reads + (isRead ? 1 : 0),
    readVia:
      isRead && !base.readVia.includes(seen.tool) ? [...base.readVia, seen.tool] : base.readVia,
    actions: !isRead && !base.actions.includes(via) ? [...base.actions, via] : base.actions,
  }
}

function tally(
  prev: readonly ServerActivity[],
  seen: Observation,
  dropped: readonly ActivityCall[],
  evicted: ReadonlyMap<string, number>,
  droppedWrites: readonly ActivityWrite[],
): ServerActivity[] {
  const byServer = new Map(prev.map((x) => [x.server, x] as const))
  const row: ServerActivity = byServer.get(seen.server) ?? {
    server: seen.server,
    firstAt: seen.at,
    lastAt: seen.at,
    calls: 0,
    reads: 0,
    writes: 0,
    errors: 0,
    denied: 0,
    unparsed: 0,
    evictedCalls: 0,
    evictedMemories: 0,
    evictedWrites: 0,
  }
  byServer.set(seen.server, {
    ...row,
    lastAt: seen.at,
    calls: row.calls + 1,
    reads: row.reads + (seen.kind === 'read' ? 1 : 0),
    writes: row.writes + (seen.kind === 'write' ? 1 : 0),
    errors: row.errors + (seen.outcome === 'error' ? 1 : 0),
    denied: row.denied + (seen.outcome === 'denied' ? 1 : 0),
    unparsed: row.unparsed + (seen.outcome === 'unparsed' ? 1 : 0),
    ...(seen.briefing === undefined ? {} : { briefing: { ...seen.briefing, at: seen.at } }),
  })
  const bump = (
    server: string,
    field: 'evictedCalls' | 'evictedMemories' | 'evictedWrites',
    n: number,
  ) => {
    const at = byServer.get(server)
    if (at !== undefined) byServer.set(server, { ...at, [field]: at[field] + n })
  }
  for (const call of dropped) bump(call.server, 'evictedCalls', 1)
  for (const write of droppedWrites) bump(write.server, 'evictedWrites', 1)
  for (const [server, n] of evicted) bump(server, 'evictedMemories', n)
  return [...byServer.values()]
}

// The stored value is this module's own, kept under a shape tag; this only
// keeps a value of another shape (a hand-edited state, a future bug) from
// breaking the fold: it starts over instead.
function isActivityState(v: unknown): v is ActivityState {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.seq === 'number' &&
    typeof s.ignored === 'number' &&
    Array.isArray(s.calls) &&
    Array.isArray(s.writes) &&
    Array.isArray(s.memories) &&
    Array.isArray(s.servers)
  )
}

// What a status line or a tab header counts, per server: distinct memories
// read and changed among those held, and how many were evicted, so a count
// can say it is a floor ("500+").
export type ServerSummary = {
  server: string
  calls: number
  read: number
  changed: number
  resolved: number
  evictedMemories: number
}

export function summarize(state: ActivityState): ServerSummary[] {
  return state.servers.map((s) => {
    const mine = state.memories.filter((m) => m.server === s.server)
    return {
      server: s.server,
      calls: s.calls,
      read: mine.filter((m) => m.reads > 0).length,
      changed: mine.filter(wasChanged).length,
      resolved: mine.filter((m) => m.actions.includes('resolved')).length,
      evictedMemories: s.evictedMemories,
    }
  })
}

// Every server's entry for one memory id. An id is a UUID, so entries under
// two servers are the same memory only when the two servers are one account:
// the caller decides which server's entry belongs to what it shows.
export function activityOf(state: ActivityState, memoryId: string): MemoryActivity[] {
  const id = memoryId.toLowerCase()
  return state.memories.filter((m) => m.id === id)
}
