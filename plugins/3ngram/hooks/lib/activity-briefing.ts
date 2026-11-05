// SPDX-License-Identifier: Apache-2.0

export type BriefingSummary = {
  generatedAt?: string
  selector: { kind: string; scope?: string; project?: string; includeUnscoped?: boolean }
  appliedScope?: string
  sections: { name: string; count: number; returned: number; hasMore: boolean }[]
}

const SECTIONS = [
  'commitments',
  'overdue',
  'blockers',
  'staleCandidates',
  'recentDecisions',
  'preferences',
]

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function label(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, limit) : undefined
}

// Copy only the summary, never section contents or extra result fields.
export function readBriefingSummary(body: Record<string, unknown>): BriefingSummary {
  const selector = object(body.selector)
  const scope = label(selector.scope, 64)
  const project = label(selector.project, 256)
  const generatedAt = label(body.generatedAt, 64)
  const appliedScope = label(body.appliedScope, 64)
  return {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(appliedScope === undefined ? {} : { appliedScope }),
    selector: {
      kind: label(selector.kind, 32) ?? 'unknown',
      ...(scope === undefined ? {} : { scope }),
      ...(project === undefined ? {} : { project }),
      ...(typeof selector.includeUnscoped === 'boolean'
        ? { includeUnscoped: selector.includeUnscoped }
        : {}),
    },
    sections: SECTIONS.flatMap((name) => {
      const section = object(body[name])
      if (
        !Array.isArray(section.items) ||
        !Number.isSafeInteger(section.count) ||
        (section.count as number) < 0
      )
        return []
      return [
        {
          name,
          count: section.count as number,
          returned: section.items.length,
          hasMore: section.hasMore === true,
        },
      ]
    }),
  }
}
