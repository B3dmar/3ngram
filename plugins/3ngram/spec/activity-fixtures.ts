// SPDX-License-Identifier: Apache-2.0

import {
  briefingToolOutputV4Schema,
  factsToolOutputSchema,
  getMemoriesOutputSchema,
  handoffToolOutputV4Schema,
  rememberToolOutputV2Schema,
  resolveToolOutputSchema,
  reviewProposalsOutputV4Schema,
  reviseToolOutputV2Schema,
  searchToolOutputV3Schema,
} from '@3ngram/schema'
import type { ObservedCall } from '../hooks/lib/observe.ts'

// Results of every 3ngram tool the activity model reads, each parsed by the
// output schema the server registers for that tool (apps/server/src/mcp), so
// a schema change that moves a field the parser reads fails here first. The
// text is what a 3ngram server sends as its one text block: the JSON of the
// structured result.

type Schema = { parse: (value: unknown) => unknown }

function checked(schema: Schema, value: object): string {
  schema.parse(value)
  return JSON.stringify(value)
}

export function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

const AT = '2026-11-05T10:00:00.000Z'

export function call(
  tool: string,
  text: string | undefined,
  args: Record<string, unknown> = {},
  more: Partial<ObservedCall> = {},
): ObservedCall {
  return {
    server: '3ngram',
    tool,
    args: { tool: `mcp__3ngram__${tool}`, tool_use_id: 'toolu_1', ...args },
    text,
    isError: false,
    isDenied: false,
    agentId: undefined,
    at: 1_000,
    ...more,
  }
}

export const remembered = checked(rememberToolOutputV2Schema, {
  memory: {
    id: id(1),
    memoryType: 'commitment',
    topic: 'Ship the session tab',
    scope: 'work',
    project: '3ngram',
  },
  embedded: 'pending',
  commitmentId: id(101),
})

export const rememberedNote = checked(rememberToolOutputV2Schema, {
  memory: { id: id(2), memoryType: 'note', topic: 'A note', scope: 'personal', project: null },
  embedded: 'off',
  factIds: [id(301)],
})

export const revisedSuccessor = checked(reviseToolOutputV2Schema, {
  memory: {
    id: id(3),
    memoryType: 'decision',
    topic: 'Use tool.call',
    scope: 'work',
    project: '3ngram',
  },
  embedded: 'pending',
})

export const revisedMove = checked(reviseToolOutputV2Schema, {
  memory: { id: id(4), memoryType: 'fact', topic: 'Refiled', scope: 'work', project: 'other' },
  embedded: 'off',
})

export const archivedDisposition = checked(reviseToolOutputV2Schema, {
  kind: 'archive',
  outcomes: [
    { memoryId: id(5), outcome: 'archived' },
    { memoryId: id(6), outcome: 'already_archived' },
    { memoryId: id(7), outcome: 'rejected', reason: 'open_commitment' },
  ],
})

export const reaffirmedDisposition = checked(reviseToolOutputV2Schema, {
  kind: 'reaffirm',
  outcomes: [{ memoryId: id(8), outcome: 'reaffirmed' }],
})

export const resolvedCommitment = checked(resolveToolOutputSchema, {
  commitmentId: id(101),
  status: 'resolved',
})

export const resolvedBlocker = checked(resolveToolOutputSchema, {
  commitmentId: id(9),
  status: 'archived',
})

function hit(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    memoryType: 'decision',
    topic: `Hit ${n}`,
    content: 'excerpt',
    contentLength: 7,
    truncated: false,
    score: 0.5,
    superseded: false,
    scope: 'work',
    project: '3ngram',
    ...extra,
  }
}

export const searched = checked(searchToolOutputV3Schema, {
  hits: [hit(10), hit(1, { memoryType: 'commitment', commitmentStatus: 'open' })],
  count: 2,
  hasMore: true,
  nextCursor: 'cursor',
  appliedScope: 'work',
})

// projection: "compact" drops content, contentLength and truncated.
export const searchedCompact = checked(searchToolOutputV3Schema, {
  hits: [
    {
      id: id(11),
      memoryType: 'note',
      topic: 'Compact',
      score: 0.1,
      superseded: true,
      scope: 'work',
      project: null,
    },
  ],
  count: 1,
  hasMore: false,
})

export const gotMemories = checked(getMemoriesOutputSchema, {
  memories: [
    {
      id: id(12),
      memoryType: 'blocker',
      topic: 'Archived blocker',
      content: 'Full content that must never be kept',
      contentLength: 36,
      truncated: false,
      scope: 'work',
      project: '3ngram',
      status: 'archived',
      supersededBy: null,
      tags: [],
      validFrom: AT,
      validTo: null,
      recordedAt: AT,
    },
  ],
  count: 1,
  notFound: [id(98)],
})

const commitmentLine = {
  id: id(201),
  memoryId: id(1),
  topic: 'Ship the session tab',
  status: 'waiting',
  dueAt: AT,
  overdue: true,
  owner: null,
  scope: 'work',
  project: '3ngram',
}

function briefingItem(n: number, memoryType: string) {
  return {
    id: id(n),
    memoryType,
    topic: `${memoryType} ${n}`,
    scope: 'work',
    project: null,
    recordedAt: AT,
    updatedAt: AT,
  }
}

// Only the sections asked for come back; an overdue commitment is listed in
// both commitments and overdue.
export const briefed = checked(briefingToolOutputV4Schema, {
  selector: { kind: 'scope_project', scope: 'work', project: '3ngram', includeUnscoped: false },
  mode: 'brief',
  generatedAt: AT,
  commitments: { count: 4, items: [commitmentLine], hasMore: true },
  overdue: { count: 1, items: [commitmentLine], hasMore: false },
  blockers: { count: 1, items: [briefingItem(13, 'blocker')], hasMore: false },
  recentDecisions: { count: 1, items: [briefingItem(14, 'decision')], hasMore: false },
})

export const handedOff = checked(handoffToolOutputV4Schema, {
  selector: { kind: 'all' },
  generatedFor: null,
  generatedAt: AT,
  decisions: [
    {
      id: id(15),
      memoryType: 'decision',
      topic: 'Handed off',
      content: 'Content that must never be kept',
      contentLength: 31,
      truncated: false,
      scope: 'work',
      project: '3ngram',
    },
  ],
  commitments: [
    { id: id(202), memoryId: id(16), topic: 'Carry this', status: 'open', dueAt: null },
  ],
  preferences: [],
  notes: [],
  counts: { decisions: 1, commitments: 1, preferences: 0 },
  truncated: { decisions: false, commitments: false, preferences: false },
})

export const facts = checked(factsToolOutputSchema, {
  facts: [
    {
      id: id(300),
      subject: 'plugin',
      predicate: 'version',
      value: '0.3.0',
      confidence: null,
      validFrom: AT,
      validTo: null,
      recordedAt: AT,
    },
  ],
  count: 1,
})

const edgeProposal = {
  id: id(400),
  fromId: id(17),
  toId: id(18),
  edgeType: 'supersedes',
  memoryType: 'decision',
  similarity: 0.92,
  rationale: null,
  status: 'proposed',
  decidedAt: null,
  createdAt: AT,
}

const factProposal = {
  id: id(401),
  memoryId: id(19),
  subject: 's',
  predicate: 'p',
  value: 'v',
  memoryType: 'fact',
  confidence: null,
  validFrom: null,
  validTo: null,
  rationale: null,
  status: 'proposed',
  decidedAt: null,
  createdAt: AT,
}

const resolutionProposal = {
  id: id(402),
  memoryId: id(1),
  sessionRunId: id(500),
  probability: 0.8,
  status: 'proposed',
  decidedAt: null,
  createdAt: AT,
}

const retentionProposal = {
  id: id(403),
  memoryId: id(20),
  action: 'supersede',
  relatedMemoryId: id(21),
  probability: 0.7,
  model: 'test',
  status: 'proposed',
  decidedAt: null,
  createdAt: AT,
}

const kinds = { edge: 1, fact: 1, resolution: 1, retention: 1 }

export const proposalsListed = checked(reviewProposalsOutputV4Schema, {
  action: 'list',
  proposals: [edgeProposal],
  count: 1,
  factProposals: [factProposal],
  resolutionProposals: [resolutionProposal],
  retentionProposals: [retentionProposal],
  counts: kinds,
  totals: kinds,
  hasMore: false,
})

export const proposalRejected = checked(reviewProposalsOutputV4Schema, {
  action: 'rejected',
  proposal: { ...edgeProposal, status: 'rejected', decidedAt: AT },
})

export const resolutionApplied = checked(reviewProposalsOutputV4Schema, {
  action: 'applied_resolution',
  proposal: { ...resolutionProposal, status: 'applied', decidedAt: AT },
  commitmentId: id(101),
  commitmentStatus: 'resolved',
})

export const retentionApplied = checked(reviewProposalsOutputV4Schema, {
  action: 'applied_retention',
  proposal: { ...retentionProposal, status: 'applied', decidedAt: AT },
})
