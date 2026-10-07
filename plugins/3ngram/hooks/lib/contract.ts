// SPDX-License-Identifier: Apache-2.0

// The stdout contract of `3ngram-hook commitments` (cmd/3ngram-hook), read on
// this side of the process boundary. The Go side is the one writer; these
// types name only what the panel reads, and parseEnvelope checks only what the
// panel's safety depends on (the contract version and the context
// fingerprint). Server enums are not re-validated here.

export const CONTRACT = '3ngram-hook.commitments.v1'

export type Selector = {
  kind: string
  scope?: string
  project?: string
  includeUnscoped?: boolean
}

export type EnvelopeContext = {
  fingerprint: string
  apiHost: string
  account?: { id: string; email: string }
  project: { name: string; source: string }
  requested: Selector
  effective?: Selector
}

export type PartialPart = { part: string; reason: string; returned?: number; total?: number }

export type ReadError = { kind: string; route?: string; status?: number; hint?: string }

export type GitHubEvidence = {
  kind: 'github_reference'
  source: 'github'
  ref: string
  referenceForm: string
  type: string
  state: string
  stateReason: string | null
  closedAt: string | null
  mergedAt: string | null
  title?: string
  url?: string
}

export type Filing = 'project' | 'unscoped' | 'unknown'

export type CommitmentRow = {
  memoryId: string
  commitmentId: string
  topic: string
  status: string
  dueAt: string | null
  overdue: boolean
  filing: Filing
  ownership: { value: string; reason: string }
  github?: GitHubEvidence[]
}

export type Counts = {
  openOrWaiting: number
  overdue: number
  returned: number
  changedDuringRead: number
}

export type GitHubWindow = { found: number; checked: number; cap: number; ambiguousSkipped: number }

export type HistoryMemory = {
  id: string
  memoryType: string
  topic: string
  project: string | null
  scope: string
  recordedAt: string
  isCurrent: boolean
}

export type EvidenceItem = {
  kind: 'related_memory' | 'consolidation_proposal'
  source: string
  edgeType: string
  relation: 'successor' | 'predecessor'
  memoryId: string
  memoryType?: string
  topic?: string
  recordedAt?: string
  current?: boolean
  proposalId?: string
  similarity?: number
  rationale?: string | null
}

export type Evidence = {
  verdict: 'review' | 'none_found'
  items: EvidenceItem[]
  inspected: {
    proposals: {
      limit: number
      returned: number
      mayHaveMore: boolean
      partnerLookups: number
    } | null
    history: {
      lineageNodeCap: number
      relationshipCap: number
      eventCap: number
      lineageTruncated: boolean
      relationshipsTruncated: boolean
      eventsTruncated: boolean
    } | null
    github?: GitHubWindow
  }
  hiddenOutsideSelector: number
  unverifiedPartners: number
  github?: GitHubEvidence[]
}

export type CommitmentDetail = {
  memoryId: string
  topic: string
  content: string
  scope: string
  project: string | null
  filing: Filing
  status: string
  commitmentStatus?: string
  current: boolean
  tags: string[]
  recordedAt: string
}

export type CommitmentHistory = {
  events: { eventKind: string; actorKind: string; createdAt: string }[]
  eventsTruncated: boolean
  lineage: HistoryMemory[]
  relationships: { memory: HistoryMemory; edge: { edgeType: string } }[]
  lineageTruncated: boolean
  relationshipsTruncated: boolean
  hiddenOutsideSelector: { nodes: number; edges: number; relationships: number }
}

export type Envelope = {
  contract: string
  operation: 'list' | 'show' | 'context'
  ok: boolean
  binary: string
  context: EnvelopeContext
  generatedAt?: string
  counts?: Counts
  commitments?: CommitmentRow[]
  partial?: PartialPart[]
  missing?: string[]
  error?: ReadError
  githubSearch?: GitHubWindow
  commitment?: CommitmentDetail
  source?: {
    createdBy: string | null
    createdAt: string | null
    session: null
    sessionReason: string
  }
  history?: CommitmentHistory
  evidence?: Evidence
}

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: 'unparseable' | 'contract' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// parseEnvelope accepts exactly one v1 envelope. Anything else (no JSON, a
// different contract, an envelope without a fingerprint, an ok list without
// rows) is refused, so the panel never shows rows it cannot attribute to a
// context.
export function parseEnvelope(stdout: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  if (!isRecord(value) || value.contract !== CONTRACT) {
    return { ok: false, reason: 'contract' }
  }
  const context = value.context
  if (!isRecord(context) || typeof context.fingerprint !== 'string' || context.fingerprint === '') {
    return { ok: false, reason: 'contract' }
  }
  if (typeof value.ok !== 'boolean' || typeof value.operation !== 'string') {
    return { ok: false, reason: 'contract' }
  }
  if (value.ok && value.operation === 'list' && !Array.isArray(value.commitments)) {
    return { ok: false, reason: 'contract' }
  }
  return { ok: true, envelope: value as unknown as Envelope }
}
