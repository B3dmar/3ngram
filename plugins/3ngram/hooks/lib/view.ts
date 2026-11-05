// SPDX-License-Identifier: Apache-2.0

import type { CommitmentRow, Envelope, PartialPart } from './contract.ts'
import { githubLabel, githubRowLabel } from './github.ts'
import type { DetailState, PanelError, PanelState } from './state.ts'
import { visibleRows } from './state.ts'
import type { Clock } from './time.ts'
import { dayOf, dueLabels, stamp } from './time.ts'

// The view model: everything the pane shows, as plain strings, so the wording
// is tested here and pane.tsx only lays it out. State is told apart by
// words, shapes and emphasis (`tone` picks bold or dim), never by color alone.
// Times are on the wall clock of the zone the caller names (lib/time.ts).

export type Tone = 'normal' | 'busy' | 'stale' | 'error'

export type RowView = { memoryId: string; title: string; labels: string[] }

export type SectionView = { title: string; rows: RowView[] }

export type PanelView = {
  header: string
  status: { label: string; tone: Tone }
  hint: string | null
  sections: SectionView[]
  notes: string[]
  footer: string | null
  empty: string | null
  canCancel: boolean
}

const FAILURE_TEXT: Record<string, string> = {
  timeout: 'The read timed out.',
  cancelled: 'The refresh was cancelled.',
  context_moved:
    'The account or backend changed during the read, so its rows are not shown. Refresh to read again.',
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
  invalid_selector:
    'The selection is not valid: including unscoped records needs a scope. Set a scope, or turn off include_unscoped, with /plugin configure 3ngram.',
  bad_response: 'The server sent a response the panel cannot read.',
  bad_request: 'The server refused the request.',
  context_changed: 'The account or selection changed; refreshing.',
  refused_scope:
    'The panel did not run 3ngram-hook: the scope option starts with "-", and no scope does. Change it with /plugin configure 3ngram.',
  refused:
    'The panel did not run 3ngram-hook: one of its own arguments would have read as a flag or was not one word. Please report this.',
  row_changed: 'This commitment changed while it was being read. Go back and open it again.',
  outside_selector: 'That commitment is outside the current selection.',
  not_found: 'That commitment no longer exists.',
  usage: 'The panel called 3ngram-hook wrongly. Please report this.',
}

export function failureText(kind: string): string {
  return FAILURE_TEXT[kind] ?? `The read failed (${kind}).`
}

// hintText is the binary's own hint for a failure (its error.hint, a fixed
// phrase of 3ngram-hook's, never record content), unless the failure's text
// already says it.
export function hintText(error: PanelError | null | undefined): string | null {
  const hint = error?.hint?.trim()
  if (!hint) return null
  const plain = (text: string) => text.toLowerCase().replaceAll('`', '')
  if (plain(failureText(error?.kind ?? '')).includes(plain(hint))) return null
  return `3ngram-hook: ${hint}`
}

// Why the binary stopped looking up GitHub references (githubParts in
// cmd/3ngram-hook); a reason not named here is shown as it came.
const GITHUB_REASON: Record<string, string> = {
  lookup_cap: 'the per-read lookup limit',
  gh_missing: 'gh is not on PATH',
  gh_unauthenticated: 'gh is not signed in: run `gh auth login`',
  rate_limited: 'GitHub is rate limiting gh',
  timeout: 'the lookups timed out',
}

// byDue orders rows by deadline, earliest first. An undated row, or one whose
// deadline does not parse, goes last: NaN would make the order inconsistent.
function byDue(a: CommitmentRow, b: CommitmentRow): number {
  const at = (r: CommitmentRow) => {
    const ms = r.dueAt === null ? Number.NaN : Date.parse(r.dueAt)
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
  }
  const [x, y] = [at(a), at(b)]
  return x === y ? 0 : x < y ? -1 : 1
}

// headerLine names what is listed: the project and the scope. The rest of the
// context (backend, account, where the project name came from, the unscoped
// opt-in) is the footer's.
export function headerLine(envelope: Envelope): string {
  const c = envelope.context
  const sel = c.effective ?? c.requested
  return `3ngram · project ${c.project.name} · ${sel.scope ? sel.scope : 'any scope'}`
}

// footerLine is the rest of the context the rows were read under, and that
// owners are not recorded when a row shown has none.
export function footerLine(envelope: Envelope, rows: CommitmentRow[]): string {
  const c = envelope.context
  const sel = c.effective ?? c.requested
  const parts = [
    c.apiHost,
    c.account ? c.account.email : 'account unavailable',
    c.project.source === 'git-remote'
      ? 'project name from the git remote'
      : 'project name from the directory name',
    sel.kind === 'scope_project' && sel.includeUnscoped
      ? 'unscoped records included'
      : 'unscoped records excluded',
  ]
  if (rows.some((r) => r.ownership.value === 'unclear')) parts.push('owners not recorded')
  return parts.join(' · ')
}

// sharesLine reports whether the header and the status fit one line of a pane
// this many columns wide, two apart; otherwise the status takes its own.
export function sharesLine(header: string, status: string, columns: number): boolean {
  // The host exposes no terminal-width primitive. Reserve two cells for
  // every non-ASCII code point, including ambiguous-width punctuation;
  // overestimating wraps the status safely instead of clipping it.
  if (/\p{Cc}/u.test(header + status)) return false
  const width = (text: string) =>
    [...text].reduce((total, char) => total + (char.charCodeAt(0) < 128 ? 1 : 2), 0)
  return width(header) + 2 + width(status) <= columns
}

// A row's labels, deadline first. Its status shows where its section does not
// already say it (an overdue row that is waiting), its filing where it is not
// the project, and its owner only where one is recorded: the footer says when
// any is not.
export function rowView(row: CommitmentRow, implied: string, clock: Clock): RowView {
  const labels = dueLabels(row.dueAt, clock, true)
  if (row.status !== implied) labels.push(row.status)
  if (row.filing === 'unscoped') labels.push('unscoped (no project)')
  if (row.filing === 'unknown') labels.push('filing unknown')
  if (row.ownership.value !== 'unclear') labels.push(`owner ${row.ownership.value}`)
  for (const g of row.github ?? []) labels.push(githubRowLabel(g))
  return { memoryId: row.memoryId, title: row.topic, labels }
}

// Each section is told apart by its mark and its word, never by color. The
// marks are narrow in every terminal: `!` is ASCII, and ◦ and ◒ are of
// neutral East Asian width, where ○ and ◐ are ambiguous and take two cells in
// a terminal set to draw ambiguous characters wide.
const MARK = { overdue: '! OVERDUE', open: '◦ OPEN', waiting: '◒ WAITING' }

// Open and waiting rows keep the server's order (its surfacing order); the
// overdue ones are re-sorted, since the binary appends the overdue split's
// rows after the commitments slice.
function sections(rows: CommitmentRow[], clock: Clock): SectionView[] {
  const overdue = rows.filter((r) => r.overdue).sort(byDue)
  const open = rows.filter((r) => !r.overdue && r.status !== 'waiting')
  const waiting = rows.filter((r) => !r.overdue && r.status === 'waiting')
  const section = (mark: string, list: CommitmentRow[], implied: string) => ({
    title: `${mark} (${list.length})`,
    rows: list.map((r) => rowView(r, implied, clock)),
  })
  return [
    section(MARK.overdue, overdue, 'open'),
    section(MARK.open, open, 'open'),
    section(MARK.waiting, waiting, 'waiting'),
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
        return `Unscoped check: the strict read failed (${p.reason.slice('strict_read_'.length)}), so rows were checked one by one, up to the lookup limit.`
      }
      return `Unscoped check: verified ${n(p.returned)} of ${n(p.total)} rows (${p.reason}); the rest are labelled "filing unknown".`
    case 'github':
      return `GitHub: checked ${n(p.returned)} of ${n(p.total)} references (${GITHUB_REASON[p.reason] ?? p.reason}).`
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

// clock is when and in which zone the view is drawn ($.clock.now(), the
// host's zone): it decides whether a time needs its date, and how far a
// deadline is.
export function panelView(s: PanelState, clock: Clock): PanelView {
  const rows = visibleRows(s)
  const envelope = rows ? s.record?.envelope : undefined
  const view: PanelView = {
    header: envelope ? headerLine(envelope) : '3ngram commitments',
    status: statusOf(s, clock),
    hint: s.status === 'error' ? hintText(s.error) : null,
    sections: rows ? sections(rows, clock) : [],
    notes: envelope ? listNotes(envelope) : [],
    footer: envelope && rows ? footerLine(envelope, rows) : null,
    empty: null,
    canCancel: s.status === 'loading' || s.status === 'refreshing',
  }
  if (rows && rows.length === 0) view.empty = 'No open or waiting commitments in this selection.'
  return view
}

// rowsFrom says how old the rows still on show are, while a refresh runs or
// after one failed.
function rowsFrom(s: PanelState, clock: Clock): string {
  return s.record ? ` Rows from ${stamp(s.record.fetchedAt, clock)}.` : ''
}

function statusOf(s: PanelState, clock: Clock): { label: string; tone: Tone } {
  switch (s.status) {
    case 'idle':
      return { label: 'Not loaded yet.', tone: 'normal' }
    case 'loading':
      return { label: 'Loading…', tone: 'busy' }
    case 'refreshing':
      return { label: `Refreshing…${rowsFrom(s, clock)}`, tone: 'busy' }
    case 'checking':
    case 'verifying':
      return { label: 'Checking the account and selection…', tone: 'busy' }
    case 'ready': {
      const at = s.record ? stamp(s.record.fetchedAt, clock) : ''
      return { label: `Updated ${at}`.trim(), tone: 'normal' }
    }
    case 'stale':
      return {
        label: `STALE since ${s.stale ? stamp(s.stale.since, clock) : '?'}: ${failureText(s.stale?.reason ?? 'unknown')}${rowsFrom(s, clock)}`,
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

// listNotice is what an open detail says about the list behind it: that the
// list went stale, which would otherwise show only after Back.
export function listNotice(s: PanelState, clock: Clock): string | null {
  return s.status === 'stale' ? statusOf(s, clock).label : null
}

// statusLine is the status-bar entry: counts only, never a topic. Counts show
// only while the rows do, so none read under another key or backend is shown
// while the context is checked; that check, before every refresh that holds
// rows, says so in its own word rather than reading as a load.
export function statusLine(s: PanelState): string | undefined {
  const counts = visibleRows(s) ? s.record?.envelope.counts : undefined
  if (s.status === 'error') return '3ngram: unavailable'
  if (!counts) {
    if (s.status === 'idle') return undefined
    return s.status === 'checking' || s.status === 'verifying'
      ? '3ngram: checking'
      : '3ngram: loading'
  }
  const base = `3ngram: ${counts.openOrWaiting} open · ${counts.overdue} overdue`
  return s.status === 'stale' ? `${base} (stale)` : base
}

export type DetailView = {
  title: string
  status: { label: string; tone: Tone }
  hint: string | null
  labels: string[]
  content: string | null
  source: string[]
  history: string[]
  evidence: string[]
  window: string[]
  notes: string[]
}

// MAX_CONTENT is how much of a commitment's content the detail draws. One
// drawing shows at most 100,000 characters, and imported content can be far
// longer, so the rest of the detail would otherwise be cut off unannounced.
export const MAX_CONTENT = 20_000

function boundedContent(content: string): string {
  const chars = [...content]
  if (chars.length <= MAX_CONTENT) return content
  return `${chars.slice(0, MAX_CONTENT).join('')}…\n\n[Showing the first ${MAX_CONTENT.toLocaleString('en-US')} of ${chars.length.toLocaleString('en-US')} characters.]`
}

// row is the list's row for the detail, which holds what the detail's answer
// does not: its deadline and its owner.
export function detailView(d: DetailState, clock: Clock, row?: CommitmentRow): DetailView {
  const base: DetailView = {
    title: 'Commitment',
    status: { label: 'Loading…', tone: 'busy' },
    hint: null,
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
      hint: hintText(d.error),
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
    view.content = boundedContent(c.content)
    view.labels = row ? dueLabels(row.dueAt, clock, true) : []
    view.labels.push(
      c.commitmentStatus ?? c.status,
      c.filing === 'unscoped' ? 'unscoped (no project)' : `project ${c.project ?? ''}`,
    )
    if (row && row.ownership.value !== 'unclear') view.labels.push(`owner ${row.ownership.value}`)
    if (!c.current) view.labels.push('no longer current')
  }
  view.source = sourceLines(e, clock)
  view.history = historyLines(e, clock)
  view.evidence = evidenceLines(e, clock)
  view.window = windowLines(e)
  view.notes = (e.partial ?? []).map(detailPartialNote)
  return view
}

function sourceLines(e: Envelope, clock: Clock): string[] {
  const src = e.source
  if (!src) return []
  // The creation event is read from the audit events: an unavailable events
  // section leaves it as unread as a failed history does.
  const parts = e.partial ?? []
  const unread = parts.some((p) => p.part === 'history')
    ? 'the history'
    : parts.some((p) => p.part === 'events')
      ? 'the audit events'
      : null
  const created =
    src.createdBy && src.createdAt
      ? `Created by ${src.createdBy} on ${dayOf(src.createdAt, clock)}.`
      : unread === null
        ? 'Creation is outside the event window.'
        : `Creation is unknown: ${unread} could not be read.`
  return [created, 'Source session: not exposed by the 3ngram read API.']
}

function historyLines(e: Envelope, clock: Clock): string[] {
  const h = e.history
  if (!h) return ['History unavailable.']
  const lines = h.events.map(
    (ev) => `${dayOf(ev.createdAt, clock)} · ${ev.eventKind} · ${ev.actorKind}`,
  )
  for (const rel of h.relationships) {
    lines.push(`Linked ${rel.memory.memoryType} "${rel.memory.topic}" (${rel.edge.edgeType})`)
  }
  // The two counts are kept apart: one hidden memory can be both a lineage
  // node and a direct link, so their sum is not a count of memories.
  const { nodes, relationships } = h.hiddenOutsideSelector
  const hidden: string[] = []
  if (nodes > 0) hidden.push(`${nodes} lineage memor${nodes === 1 ? 'y' : 'ies'}`)
  if (relationships > 0)
    hidden.push(`${relationships} direct link${relationships === 1 ? '' : 's'}`)
  if (hidden.length > 0) lines.push(`Outside this selection and hidden: ${hidden.join(', ')}.`)
  return lines
}

function evidenceLines(e: Envelope, clock: Clock): string[] {
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
    lines.push(`Related on GitHub: ${githubLabel(g, clock)}${g.title ? `: ${g.title}` : ''}`)
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
      : ev.verdict === 'not_inspected'
        ? 'No evidence source could be read, so nothing was searched.'
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
