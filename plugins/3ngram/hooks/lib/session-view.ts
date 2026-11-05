// SPDX-License-Identifier: Apache-2.0

import type {
  ActivityState,
  ActivityWrite,
  MemoryActivity,
  ServerSummary,
  WriteAction,
} from './activity.ts'
import { summarize } from './activity.ts'
import type { BriefingSummary } from './activity-briefing.ts'
import type { Clock } from './time.ts'
import { stamp } from './time.ts'

export type SessionRow = { key: string; title: string; labels: string }
export type SessionServer = {
  name: string
  counts: string
  notes: string[]
  writes: SessionRow[]
  reads: SessionRow[]
  briefing: string[]
}
export type SessionView = { servers: SessionServer[]; notes: string[] }

// Metadata is rendered as text, never Markdown or terminal control sequences.
function label(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
}

function counts(s: ServerSummary, compact = false): string {
  const suffix = s.evictedMemories > 0 ? '+' : ''
  const count = (n: number) => `${n}${suffix}`
  return compact
    ? `${count(s.read)} read · ${count(s.changed)} wrote · ${count(s.resolved)} resolved`
    : `Read ${count(s.read)} · Wrote ${count(s.changed)} · Resolved ${count(s.resolved)}`
}

// This line contains counts alone: no server, topic, selector or memory ID.
export function activityStatus(state: ActivityState): string {
  const summaries = summarize(state)
  if (summaries.length === 0) return ''
  if (summaries.length > 1)
    return `activity in ${summaries.length}${state.ignored ? '+' : ''} servers`
  const summary = summaries[0]
  return summary ? counts(summary, true) : ''
}

const ACTION: Record<WriteAction, string> = {
  remembered: 'remembered',
  revised: 'superseded',
  successor: 'revision written',
  moved: 'moved',
  archived: 'archived',
  reaffirmed: 'reaffirmed',
  resolved: 'resolved',
  status_changed: 'status changed',
  proposal_applied: 'proposal applied',
  proposal_rejected: 'proposal rejected',
}

function filing(m: Pick<MemoryActivity, 'memoryType' | 'scope' | 'project'>): string[] {
  return [m.memoryType, m.scope, m.project === null ? 'no project' : m.project]
    .filter((part): part is string => part !== undefined)
    .map(label)
}

function writeRow(w: ActivityWrite, clock: Clock): SessionRow {
  return {
    key: `${w.seq}-${w.id}-${w.via}`,
    title: label(w.topic ?? w.id),
    labels: [
      stamp(w.at, clock),
      w.via === 'read' ? 'read' : ACTION[w.via],
      w.commitmentStatus,
      ...filing(w),
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

function readRow(m: MemoryActivity): SessionRow {
  return {
    key: m.id,
    title: label(m.topic ?? m.id),
    labels: [`${m.reads} reads`, ...filing(m)].join(' · '),
  }
}

const SECTION: Record<string, string> = {
  commitments: 'Commitments',
  overdue: 'Overdue',
  blockers: 'Blockers',
  staleCandidates: 'Stale candidates',
  recentDecisions: 'Recent decisions',
  preferences: 'Preferences',
}

function briefingLines(
  briefing: (BriefingSummary & { at: number }) | undefined,
  clock: Clock,
): string[] {
  if (!briefing) return ['No MCP briefing observed.']
  const { selector } = briefing
  const selection = [
    label(selector.kind),
    selector.scope && `scope ${label(selector.scope)}`,
    selector.project && `project ${label(selector.project)}`,
    selector.includeUnscoped === undefined
      ? undefined
      : selector.includeUnscoped
        ? 'includes unscoped'
        : 'excludes unscoped',
    briefing.appliedScope && `applied scope ${label(briefing.appliedScope)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return [
    `Observed ${stamp(briefing.at, clock)} · ${selection}`,
    ...briefing.sections.map(
      (s) =>
        `${SECTION[s.name] ?? label(s.name)}: ${s.count} total · ${s.returned} returned${s.hasMore ? ' · truncated' : ''}`,
    ),
  ]
}

export function sessionView(state: ActivityState, clock: Clock): SessionView {
  const summaries = summarize(state)
  return {
    notes: [
      'Distinct memories per server. Repeated reads affect ranking.',
      'Observed MCP calls only; automatic startup briefings are not included.',
      ...(state.ignored ? [`${state.ignored} calls omitted beyond the 16-server limit.`] : []),
    ],
    servers: state.servers.map((server, i) => {
      const summary = summaries[i]
      const writes = state.writes.filter((w) => w.server === server.server).reverse()
      const reads = state.memories
        .filter((m) => m.server === server.server && m.reads > 0)
        .sort((a, b) => b.reads - a.reads || b.lastCall - a.lastCall)
      return {
        name: label(server.server),
        counts: summary ? counts(summary) : '',
        notes: [
          `${server.calls} calls · ${server.errors} errors · ${server.denied} denied · ${server.unparsed} unparsed`,
          ...(server.evictedMemories
            ? [
                `${server.evictedMemories} memory entries omitted; counts and read frequencies are lower bounds (+).`,
              ]
            : []),
          ...(server.evictedCalls
            ? [`${server.evictedCalls} older calls omitted from history.`]
            : []),
          ...(server.evictedWrites ? [`${server.evictedWrites} older write events omitted.`] : []),
          ...(server.errors || server.denied || server.unparsed
            ? ['Memory counts exclude failed, denied and unparsed results.']
            : []),
          ...(writes.length > 5 ? [`Showing 5 of ${writes.length} retained write events.`] : []),
          ...(reads.length > 5 ? [`Showing 5 of ${reads.length} retained read memories.`] : []),
        ],
        writes: writes.slice(0, 5).map((w) => writeRow(w, clock)),
        reads: reads.slice(0, 5).map(readRow),
        briefing: briefingLines(server.briefing, clock),
      }
    }),
  }
}
