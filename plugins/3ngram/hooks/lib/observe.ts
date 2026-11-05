// SPDX-License-Identifier: Apache-2.0

import type {
  CallKind,
  CallOutcome,
  CommitmentStatus,
  MemoryStatus,
  WriteAction,
} from './activity.ts'
import { type BriefingSummary, readBriefingSummary } from './activity-briefing.ts'

// Reads one observed tool call into what the activity model folds
// (activity.ts): which 3ngram tool it was, and the memories its result listed
// or its arguments and result say it changed. Pure, and total: any input,
// however malformed, is a counted call, never a throw.
//
// A 3ngram server's tools answer with one text block holding the JSON of
// their structured result (apps/server/src/mcp), which is the `text` the
// engine hands a tool.call hook. That text is what is read here; the shapes
// are packages/schema's output schemas, pinned by spec/activity.spec.ts.

// The tools a 3ngram MCP server registers (apps/server/src/mcp/tools.ts).
// configure_scope and describe_environment answer with no memory.
export const THREENGRAM_TOOLS = [
  'remember',
  'revise',
  'resolve',
  'search',
  'get_memories',
  'briefing',
  'handoff',
  'get_facts',
  'review_proposals',
  'configure_scope',
  'describe_environment',
] as const

// A server is taken for 3ngram when its name holds `3ngram` as a word of its
// own, between the ends or `-` and `_`: `3ngram`, `3ngram-personal`,
// `claude_ai_3ngram` (a claude.ai connector, as Claude Code spells it).
//
// By name, because the name is all a tool.call hook is given: the engine's
// McpServerProvenance rides the classic hook inputs (PreToolUse,
// PostToolUse), not tool.call's, and even there its `source` says where a
// server's configuration came from, not whether it is 3ngram. A server
// named so that is not 3ngram would have its calls counted. That is the
// accepted cost: the model drives a display, it never acts on a call.
const SERVER_WORD = /(?:^|[_-])3ngram(?:[_-]|$)/i
const MAX_NAME = 128

export type ToolName = { server: string; tool: string }

// threengramCall splits `mcp__<server>__<tool>` at its last `__` (no 3ngram
// tool name holds one) and keeps it when the server is 3ngram's. A tool the
// set above does not name is still counted, as `other`.
export function threengramCall(toolName: string): ToolName | null {
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.lastIndexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return null
  const server = rest.slice(0, cut)
  const tool = rest.slice(cut + 2)
  if (server.length > MAX_NAME || tool.length > MAX_NAME) return null
  return SERVER_WORD.test(server) ? { server, tool } : null
}

export type ObservedCall = ToolName & {
  // The tool's arguments as the hook received them (reserved keys beside).
  args: Readonly<Record<string, unknown>>
  // The result as the model read it; absent on a refusal.
  text: string | undefined
  isError: boolean
  isDenied: boolean
  agentId: string | undefined
  at: number
}

export type MemoryEntry = {
  id: string
  via: 'read' | WriteAction
  memoryType?: string
  topic?: string
  scope?: string
  project?: string | null
  status?: MemoryStatus
  commitmentStatus?: CommitmentStatus
}

export type Observation = {
  at: number
  server: string
  tool: string
  kind: CallKind
  outcome: CallOutcome
  agentId?: string
  returned: number
  entries: MemoryEntry[]
  briefing?: BriefingSummary
}

export const TOPIC_LIMIT = 200

export function observe(call: ObservedCall): Observation {
  const agentId = bounded(call.agentId, MAX_NAME)
  const base = {
    at: call.at,
    server: call.server,
    tool: call.tool,
    kind: kindOf(call.tool, call.args),
    ...(agentId === undefined ? {} : { agentId }),
    returned: 0,
    entries: [],
  }
  if (call.isDenied) return { ...base, outcome: 'denied' }
  if (call.isError) return { ...base, outcome: 'error' }
  const reader = READERS.get(call.tool)
  if (reader === undefined) return { ...base, outcome: 'ok' }
  const read = readResult(reader, call)
  if (read === null) return { ...base, outcome: 'unparsed' }
  return { ...base, ...read, outcome: 'ok', entries: dedupe(read.entries) }
}

function kindOf(tool: string, args: Readonly<Record<string, unknown>>): CallKind {
  switch (tool) {
    case 'remember':
    case 'revise':
    case 'resolve':
      return 'write'
    case 'search':
    case 'get_memories':
    case 'briefing':
    case 'handoff':
    case 'get_facts':
      return 'read'
    case 'review_proposals':
      return args.action === 'reject' || args.action === 'accept' ? 'write' : 'read'
    default:
      return 'other'
  }
}

type Json = Readonly<Record<string, unknown>>
type Read = { returned: number; entries: MemoryEntry[]; briefing?: BriefingSummary }
type Reader = (body: Json, args: Json) => Read | null

// readResult never throws: the readers check every field they take, and a
// failure none of them foresaw still only makes the call unparsed.
function readResult(reader: Reader, call: ObservedCall): Read | null {
  try {
    if (call.text === undefined) return null
    const body = record(JSON.parse(call.text))
    return body === null ? null : reader(body, call.args)
  } catch {
    return null
  }
}

function record(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null
}

function rows(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuid(v: unknown): string | undefined {
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined
}

function bounded(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
}

// A topic is cut at TOPIC_LIMIT code points, never inside one.
function topicOf(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined
  if (v.length <= TOPIC_LIMIT) return v
  const points = Array.from(v)
  return points.length <= TOPIC_LIMIT ? v : `${points.slice(0, TOPIC_LIMIT - 1).join('')}…`
}

const COMMITMENT_STATUSES: readonly string[] = ['open', 'waiting', 'resolved', 'expired']

function commitmentStatusOf(v: unknown): CommitmentStatus | undefined {
  return typeof v === 'string' && COMMITMENT_STATUSES.includes(v)
    ? (v as CommitmentStatus)
    : undefined
}

function memoryStatusOf(v: unknown): MemoryStatus | undefined {
  return v === 'active' || v === 'archived' ? v : undefined
}

// describe reads the filing and the topic a result line carries, leaving out
// what it does not say. A project is kept only within the schema's bound.
function describe(o: Json): Omit<MemoryEntry, 'id' | 'via'> {
  const memoryType = bounded(o.memoryType, 32)
  const topic = topicOf(o.topic)
  const scope = bounded(o.scope, 64)
  const project = o.project === null ? null : bounded(o.project, 256)
  return {
    ...(memoryType === undefined ? {} : { memoryType }),
    ...(topic === undefined ? {} : { topic }),
    ...(scope === undefined ? {} : { scope }),
    ...(project === undefined ? {} : { project }),
  }
}

// memoryLine is a result line naming a memory by `id` (a search hit, a
// get_memories row, a briefing or handoff memory, a written memory).
function memoryLine(raw: unknown, via: MemoryEntry['via']): MemoryEntry | null {
  const o = record(raw)
  const id = uuid(o?.id)
  if (o === null || id === undefined) return null
  const status = memoryStatusOf(o.status)
  const commitmentStatus = commitmentStatusOf(o.commitmentStatus)
  return {
    id,
    via,
    ...describe(o),
    ...(status === undefined ? {} : { status }),
    ...(commitmentStatus === undefined ? {} : { commitmentStatus }),
  }
}

// commitmentLine is a briefing or handoff commitment: its `id` is the
// commitment's, `memoryId` the memory's, `status` the commitment's.
function commitmentLine(raw: unknown): MemoryEntry | null {
  const o = record(raw)
  const id = uuid(o?.memoryId)
  if (o === null || id === undefined) return null
  const commitmentStatus = commitmentStatusOf(o.status)
  return {
    id,
    via: 'read',
    ...describe(o),
    memoryType: 'commitment',
    ...(commitmentStatus === undefined ? {} : { commitmentStatus }),
  }
}

function lines(raws: unknown[], read: (raw: unknown) => MemoryEntry | null): MemoryEntry[] {
  return raws.map(read).filter((e): e is MemoryEntry => e !== null)
}

function readRemember(body: Json): Read | null {
  const written = memoryLine(body.memory, 'remembered')
  if (written === null) return null
  // remember opens a commitment in the same write (rememberToolOutputSchema).
  const opened = written.memoryType === 'commitment' && uuid(body.commitmentId) !== undefined
  return { returned: 1, entries: [opened ? { ...written, commitmentStatus: 'open' } : written] }
}

function readRevise(body: Json, args: Json): Read | null {
  if (Array.isArray(body.outcomes)) return readDisposition(body.outcomes)
  const isMove = args.kind === 'move'
  const written = memoryLine(body.memory, isMove ? 'moved' : 'successor')
  if (written === null) return null
  const before = uuid(args.predecessorId)
  const revised: MemoryEntry[] =
    !isMove && before !== undefined && before !== written.id ? [{ id: before, via: 'revised' }] : []
  return { returned: 1, entries: [written, ...revised] }
}

// A revise disposition reports one outcome per id; a rejected one changed
// nothing, so it records nothing.
function readDisposition(outcomes: unknown[]): Read {
  const entries: MemoryEntry[] = []
  for (const raw of outcomes) {
    const o = record(raw)
    const id = uuid(o?.memoryId)
    if (id === undefined) continue
    if (o?.outcome === 'archived') entries.push({ id, via: 'archived', status: 'archived' })
    else if (o?.outcome === 'reaffirmed') entries.push({ id, via: 'reaffirmed' })
  }
  return { returned: outcomes.length, entries }
}

// resolve names the memory in its arguments; its result is the commitment's
// id (a blocker's memory id) and the status it settled on.
function readResolve(body: Json, args: Json): Read | null {
  if (uuid(body.commitmentId) === undefined || typeof body.status !== 'string') return null
  const id = uuid(args.memoryId)
  if (id === undefined) return { returned: 1, entries: [] }
  const commitmentStatus = commitmentStatusOf(body.status)
  const settled: Partial<MemoryEntry> =
    body.status === 'archived'
      ? { status: 'archived' }
      : commitmentStatus === undefined
        ? {}
        : { commitmentStatus }
  const via =
    body.status === 'resolved' || body.status === 'archived' ? 'resolved' : 'status_changed'
  return { returned: 1, entries: [{ id, via, ...settled }] }
}

function readList(field: string): Reader {
  return (body) => {
    if (!Array.isArray(body[field])) return null
    const raws = rows(body[field])
    return { returned: raws.length, entries: lines(raws, (r) => memoryLine(r, 'read')) }
  }
}

const BRIEFING_COMMITMENTS = ['commitments', 'overdue'] as const
const BRIEFING_MEMORIES = ['blockers', 'staleCandidates', 'recentDecisions', 'preferences'] as const

// A briefing computes only the sections asked for, each `{ count, items }`.
function readBriefing(body: Json): Read | null {
  const items = (name: string) => rows(record(body[name])?.items)
  const present = [...BRIEFING_COMMITMENTS, ...BRIEFING_MEMORIES].some((n) =>
    Array.isArray(record(body[n])?.items),
  )
  if (!present) return null
  const commitments = BRIEFING_COMMITMENTS.flatMap(items)
  const memories = BRIEFING_MEMORIES.flatMap(items)
  return {
    returned: commitments.length + memories.length,
    briefing: readBriefingSummary(body),
    entries: [
      ...lines(commitments, commitmentLine),
      ...lines(memories, (r) => memoryLine(r, 'read')),
    ],
  }
}

function readHandoff(body: Json): Read | null {
  if (!['decisions', 'commitments', 'preferences'].every((n) => Array.isArray(body[n]))) return null
  const memories = [...rows(body.decisions), ...rows(body.preferences)]
  const commitments = rows(body.commitments)
  return {
    returned: memories.length + commitments.length,
    entries: [
      ...lines(memories, (r) => memoryLine(r, 'read')),
      ...lines(commitments, commitmentLine),
    ],
  }
}

// A fact names no memory (factSchema): the call counts what it returned.
function readFacts(body: Json): Read | null {
  return Array.isArray(body.facts) ? { returned: body.facts.length, entries: [] } : null
}

// The memory ids a proposal names: an edge proposal its two ends, a fact or
// resolution proposal its memory, a retention proposal its memory and the
// one it relates to.
function proposalIds(raw: unknown): string[] {
  const o = record(raw)
  if (o === null) return []
  return [o.fromId, o.toId, o.memoryId, o.relatedMemoryId]
    .map(uuid)
    .filter((id): id is string => id !== undefined)
}

function readProposals(body: Json): Read | null {
  const action = body.action
  if (action === 'list') {
    const all = ['proposals', 'factProposals', 'resolutionProposals', 'retentionProposals'].flatMap(
      (n) => rows(body[n]),
    )
    const entries = all.flatMap(proposalIds).map((id): MemoryEntry => ({ id, via: 'read' }))
    return { returned: all.length, entries }
  }
  if (typeof action !== 'string' || record(body.proposal) === null) return null
  const via = action.startsWith('applied')
    ? 'proposal_applied'
    : action.startsWith('rejected')
      ? 'proposal_rejected'
      : null
  if (via === null) return null
  const commitmentStatus = commitmentStatusOf(body.commitmentStatus)
  const settled = action === 'applied_resolution' && commitmentStatus !== undefined
  return {
    returned: 1,
    entries: proposalIds(body.proposal).map((id) => ({
      id,
      via,
      ...(settled ? { commitmentStatus } : {}),
    })),
  }
}

const READERS: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ['remember', readRemember],
  ['revise', readRevise],
  ['resolve', readResolve],
  ['search', readList('hits')],
  ['get_memories', readList('memories')],
  ['briefing', readBriefing],
  ['handoff', readHandoff],
  ['get_facts', readFacts],
  ['review_proposals', readProposals],
])

// dedupe keeps one entry per memory and use: a briefing lists an overdue
// commitment twice, and a read is one read per call. The later line's fields
// fill in what the earlier one left out.
function dedupe(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const byKey = new Map<string, MemoryEntry>()
  for (const e of entries) {
    const key = `${e.id}\n${e.via}`
    const held = byKey.get(key)
    byKey.set(key, held === undefined ? e : { ...e, ...held })
  }
  return [...byKey.values()]
}
