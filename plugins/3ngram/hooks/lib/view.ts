// SPDX-License-Identifier: Apache-2.0

import type { CommitmentRow, Envelope, GitHubEvidence, PartialPart } from './contract.ts'
import type { DetailState, PanelState } from './state.ts'
import { visibleRows } from './state.ts'

// The view model: everything the pane shows, as plain strings, so the wording
// is tested here and register.tsx only lays it out. State is told apart by
// words and emphasis (`tone` picks bold or dim), never by color alone.

export type Tone = 'normal' | 'busy' | 'stale' | 'error'

export type RowView = { memoryId: string; title: string; labels: string[] }

export type SectionView = { title: string; rows: RowView[] }

export type PanelView = {
  header: string[]
  status: { label: string; tone: Tone }
  sections: SectionView[]
  notes: string[]
  empty: string | null
  canCancel: boolean
}

const FAILURE_TEXT: Record<string, string> = {
  timeout: 'The read timed out.',
  cancelled: 'The refresh was cancelled.',
  missing_binary: '3ngram-hook is not on PATH. Install it to use the panel.',
  too_old: 'This 3ngram-hook has no commitments command. Rebuild it from the 3ngram repository.',
  crash: '3ngram-hook stopped without an answer.',
  unparseable: '3ngram-hook answered with something that is not an envelope.',
  contract: '3ngram-hook answered with an envelope this panel does not understand.',
  auth: 'The 3ngram API key was refused. Run `3ngram-hook verify`.',
  no_key: 'No 3ngram API key was found (THREENGRAM_API_KEY or ~/.config/3ngram/api-key).',
  unavailable: 'The 3ngram API is unavailable.',
  rate_limited: 'The 3ngram API is rate limiting this key.',
  route_missing: 'This 3ngram server is too old for the panel.',
  selector_mismatch: 'The server answered for a wider selection than asked; nothing is shown.',
  invalid_selector: 'The selection is not valid. Including unscoped records needs a scope.',
  bad_response: 'The server sent a response the panel cannot read.',
  bad_request: 'The server refused the request.',
  context_changed: 'The account or selection changed; refreshing.',
  outside_selector: 'That commitment is outside the current selection.',
  not_found: 'That commitment no longer exists.',
  usage: 'The panel called 3ngram-hook wrongly. Please report this.',
}

export function failureText(kind: string): string {
  return FAILURE_TEXT[kind] ?? `The read failed (${kind}).`
}

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

function day(iso: string): string {
  return iso.slice(0, 10)
}

export function headerLines(envelope: Envelope): string[] {
  const c = envelope.context
  const account = c.account ? c.account.email : 'account unavailable'
  const source =
    c.project.source === 'git-remote' ? 'from the git remote' : 'from the directory name'
  const sel = c.effective ?? c.requested
  const scope = sel.scope ? `scope ${sel.scope}` : 'any scope'
  const unscoped =
    sel.kind === 'scope_project' && sel.includeUnscoped
      ? 'unscoped records included'
      : 'unscoped records excluded'
  return [
    `${c.apiHost} · ${account}`,
    `project ${c.project.name} (${source}) · ${scope} · ${unscoped}`,
  ]
}

export function githubLabel(g: GitHubEvidence): string {
  const kind = g.type === 'pull_request' ? 'PR' : g.type === 'issue' ? 'issue' : 'ref'
  switch (g.state) {
    case 'merged':
      return `${kind} ${g.ref} merged${g.mergedAt ? ` ${day(g.mergedAt)}` : ''}`
    case 'closed': {
      const how =
        g.type === 'pull_request'
          ? ' without merging'
          : g.stateReason === 'not_planned'
            ? ' as not planned'
            : ''
      return `${kind} ${g.ref} closed${how}${g.closedAt ? ` ${day(g.closedAt)}` : ''}`
    }
    case 'not_found':
      return `${g.ref} not found or not visible`
    default:
      return `${kind} ${g.ref} ${g.state}`
  }
}

export function rowView(row: CommitmentRow): RowView {
  const labels: string[] = []
  if (row.overdue) labels.push('OVERDUE')
  labels.push(row.status)
  labels.push(row.dueAt ? `due ${day(row.dueAt)}` : 'no due date recorded')
  if (row.filing === 'unscoped') labels.push('unscoped (no project)')
  if (row.filing === 'unknown') labels.push('filing unknown')
  labels.push(
    row.ownership.value === 'unclear'
      ? 'owner unclear (not recorded)'
      : `owner ${row.ownership.value}`,
  )
  for (const g of row.github ?? []) labels.push(githubLabel(g))
  return { memoryId: row.memoryId, title: row.topic, labels }
}

function sections(rows: CommitmentRow[]): SectionView[] {
  const overdue = rows.filter((r) => r.overdue)
  const open = rows.filter((r) => !r.overdue && r.status !== 'waiting')
  const waiting = rows.filter((r) => !r.overdue && r.status === 'waiting')
  return [
    { title: `Overdue (${overdue.length})`, rows: overdue.map(rowView) },
    { title: `Open (${open.length})`, rows: open.map(rowView) },
    { title: `Waiting (${waiting.length})`, rows: waiting.map(rowView) },
  ].filter((s) => s.rows.length > 0)
}

export function partialNote(p: PartialPart): string {
  const n = (v: number | undefined) => v ?? 0
  switch (p.part) {
    case 'commitments':
      return `Showing ${n(p.returned)} of ${n(p.total)} open or waiting commitments.`
    case 'overdue':
      return `Showing ${n(p.returned)} of ${n(p.total)} overdue commitments.`
    case 'account':
      return `The account could not be read (${p.reason}).`
    case 'filing':
      if (p.reason.startsWith('strict_read_')) {
        return `Unscoped check: the strict read failed (${p.reason.slice('strict_read_'.length)}), so every row was checked on its own.`
      }
      return `Unscoped check: verified ${n(p.returned)} of ${n(p.total)} rows (${p.reason}); the rest are labelled "filing unknown".`
    case 'github':
      return `GitHub: checked ${n(p.returned)} of ${n(p.total)} references (${p.reason}).`
    default:
      return `${p.part}: incomplete (${p.reason}).`
  }
}

function listNotes(envelope: Envelope): string[] {
  const notes = (envelope.partial ?? []).map(partialNote)
  const changed = envelope.counts?.changedDuringRead ?? 0
  if (changed > 0) notes.push(`${changed} row(s) changed while being read and are left out.`)
  const ambiguous = envelope.githubSearch?.ambiguousSkipped ?? 0
  if (ambiguous > 0) {
    notes.push(
      `${ambiguous} bare #N reference(s) skipped as ambiguous; write owner/repo#N to look them up.`,
    )
  }
  if ((envelope.missing ?? []).includes('owner')) {
    notes.push('Owners and source sessions are not exposed by the 3ngram read API.')
  }
  return notes
}

export function panelView(s: PanelState): PanelView {
  const rows = visibleRows(s)
  const envelope = rows ? s.record?.envelope : undefined
  const view: PanelView = {
    header: envelope ? headerLines(envelope) : ['3ngram commitments'],
    status: statusOf(s),
    sections: rows ? sections(rows) : [],
    notes: envelope ? listNotes(envelope) : [],
    empty: null,
    canCancel: s.status === 'loading' || s.status === 'refreshing',
  }
  if (rows && rows.length === 0) view.empty = 'No open or waiting commitments in this selection.'
  return view
}

function statusOf(s: PanelState): { label: string; tone: Tone } {
  switch (s.status) {
    case 'idle':
      return { label: 'Not loaded yet.', tone: 'normal' }
    case 'loading':
      return { label: 'Loading…', tone: 'busy' }
    case 'refreshing':
      return { label: 'Refreshing…', tone: 'busy' }
    case 'verifying':
      return { label: 'Checking the account and selection…', tone: 'busy' }
    case 'ready':
      return { label: `Updated ${s.record ? time(s.record.fetchedAt) : ''}`.trim(), tone: 'normal' }
    case 'stale':
      return {
        label: `STALE since ${s.stale ? time(s.stale.since) : '?'}: ${failureText(s.stale?.reason ?? 'unknown')}`,
        tone: 'stale',
      }
    case 'error': {
      const kind = s.error?.kind ?? 'unknown'
      const unverified = s.error?.contextUnverified
        ? ' The account or selection could not be confirmed, so nothing is shown.'
        : ''
      return { label: `ERROR: ${failureText(kind)}${unverified}`, tone: 'error' }
    }
  }
}

// statusLine is the status-bar entry: counts only, never a topic.
export function statusLine(s: PanelState): string | undefined {
  const counts = visibleRows(s) ? s.record?.envelope.counts : undefined
  if (s.status === 'error') return '3ngram: unavailable'
  if (!counts) return s.status === 'idle' ? undefined : '3ngram: loading'
  const base = `3ngram: ${counts.openOrWaiting} open · ${counts.overdue} overdue`
  return s.status === 'stale' ? `${base} (stale)` : base
}

export type DetailView = {
  title: string
  status: { label: string; tone: Tone }
  labels: string[]
  content: string | null
  source: string[]
  history: string[]
  evidence: string[]
  window: string[]
  notes: string[]
}

export function detailView(d: DetailState): DetailView {
  const base: DetailView = {
    title: 'Commitment',
    status: { label: 'Loading…', tone: 'busy' },
    labels: [],
    content: null,
    source: [],
    history: [],
    evidence: [],
    window: [],
    notes: [],
  }
  if (d.status === 'loading') return base
  if (d.status === 'error' || !d.envelope) {
    return {
      ...base,
      status: { label: `ERROR: ${failureText(d.error?.kind ?? 'unknown')}`, tone: 'error' },
    }
  }
  const e = d.envelope
  const c = e.commitment
  const view: DetailView = {
    ...base,
    status: { label: 'Read-only. Nothing here changes a record.', tone: 'normal' },
  }
  if (c) {
    view.title = c.topic
    view.content = c.content
    view.labels = [
      c.commitmentStatus ?? c.status,
      c.filing === 'unscoped' ? 'unscoped (no project)' : `project ${c.project ?? ''}`,
    ]
    if (!c.current) view.labels.push('no longer current')
  }
  view.source = sourceLines(e)
  view.history = historyLines(e)
  view.evidence = evidenceLines(e)
  view.window = windowLines(e)
  view.notes = (e.partial ?? []).map(detailPartialNote)
  return view
}

function sourceLines(e: Envelope): string[] {
  const src = e.source
  if (!src) return []
  const created =
    src.createdBy && src.createdAt
      ? `Created by ${src.createdBy} on ${day(src.createdAt)}.`
      : 'Creation is outside the event window.'
  return [created, 'Source session: not exposed by the 3ngram read API.']
}

function historyLines(e: Envelope): string[] {
  const h = e.history
  if (!h) return ['History unavailable.']
  const lines = h.events.map((ev) => `${day(ev.createdAt)} · ${ev.eventKind} · ${ev.actorKind}`)
  for (const rel of h.relationships) {
    lines.push(`Linked ${rel.memory.memoryType} "${rel.memory.topic}" (${rel.edge.edgeType})`)
  }
  const hidden = h.hiddenOutsideSelector.nodes + h.hiddenOutsideSelector.relationships
  if (hidden > 0)
    lines.push(
      `${hidden} related memor${hidden === 1 ? 'y is' : 'ies are'} outside this selection and hidden.`,
    )
  return lines
}

function evidenceLines(e: Envelope): string[] {
  const ev = e.evidence
  if (!ev) return []
  const lines: string[] = []
  for (const item of ev.items) {
    const topic = item.topic ? `"${item.topic}"` : 'a memory'
    if (item.kind === 'related_memory') {
      lines.push(`Newer ${item.memoryType ?? 'memory'} ${topic} ${item.edgeType} this commitment.`)
    } else {
      const would =
        item.relation === 'successor'
          ? `would ${verb(item.edgeType)} this commitment`
          : `would be ${verb(item.edgeType)}d by this commitment`
      const why = item.rationale ? ` Rationale: ${item.rationale}` : ''
      lines.push(
        `Pending proposal: ${topic} ${would} (similarity ${(item.similarity ?? 0).toFixed(2)}).${why}`,
      )
    }
  }
  for (const g of ev.github ?? [])
    lines.push(`Related on GitHub: ${githubLabel(g)}${g.title ? `: ${g.title}` : ''}`)
  if (ev.hiddenOutsideSelector > 0)
    lines.push(
      `${ev.hiddenOutsideSelector} proposal(s) involve memories outside this selection and are hidden.`,
    )
  if (ev.unverifiedPartners > 0)
    lines.push(
      `${ev.unverifiedPartners} proposal(s) could not be checked against this selection and are hidden.`,
    )
  lines.unshift(
    ev.verdict === 'review'
      ? 'Related evidence to review. It does not prove the commitment is done.'
      : 'No evidence found in the inspected window.',
  )
  return lines
}

function verb(edgeType: string): string {
  return edgeType === 'supersedes' ? 'supersede' : edgeType === 'extends' ? 'extend' : 'update'
}

function windowLines(e: Envelope): string[] {
  const w = e.evidence?.inspected
  if (!w) return []
  const lines: string[] = []
  lines.push(
    w.proposals
      ? `Proposals: the newest ${w.proposals.returned} pending (limit ${w.proposals.limit}, tenant-wide)${w.proposals.mayHaveMore ? '; more may exist' : ''}.`
      : 'Proposals: not inspected.',
  )
  lines.push(
    w.history
      ? `History: up to ${w.history.relationshipCap} relationships and ${w.history.eventCap} events${w.history.relationshipsTruncated || w.history.eventsTruncated ? ', truncated' : ''}.`
      : 'History: not inspected.',
  )
  if (w.github)
    lines.push(
      `GitHub: ${w.github.checked} of ${w.github.found} references checked (cap ${w.github.cap}).`,
    )
  return lines
}

function detailPartialNote(p: PartialPart): string {
  switch (p.part) {
    case 'proposals':
      return p.reason === 'window'
        ? 'Proposals: only the newest window was inspected.'
        : `Proposals could not be read (${p.reason}).`
    case 'proposal_partners':
      return `Proposal partners: checked ${p.returned ?? 0} of ${p.total ?? 0} (${p.reason}).`
    case 'history':
      return `History could not be read (${p.reason}).`
    case 'lineage':
    case 'relationships':
    case 'events':
      return `${p.part[0]?.toUpperCase()}${p.part.slice(1)}: ${p.reason}.`
    default:
      return partialNote(p)
  }
}
