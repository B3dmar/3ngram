// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { CONSOLIDATION_POLICIES } from '../src/consolidation.js'
import { EDGE_TYPES, MEMORY_TYPES } from '../src/memory.js'

describe('consolidation policy (docs/concepts/memory-model.mdx "Consolidation is advisory")', () => {
  it('S1 invariant: event memories are never auto-edge eligible', () => {
    expect(CONSOLIDATION_POLICIES.event.autoEdgeEligible).toBe(false)
  })

  it('S1 invariant: event memories may only receive advisory extends proposals', () => {
    expect(CONSOLIDATION_POLICIES.event.proposableEdges).toEqual(['extends'])
  })

  it('every memory type has a policy', () => {
    expect(Object.keys(CONSOLIDATION_POLICIES).sort()).toEqual([...MEMORY_TYPES].sort())
  })

  it('only semantic types start auto-edge eligible', () => {
    const eligible = Object.entries(CONSOLIDATION_POLICIES)
      .filter(([, p]) => p.autoEdgeEligible)
      .map(([t]) => t)
      .sort()
    expect(eligible).toEqual(['fact', 'preference'])
  })

  it('proposable edges are valid edge types and never empty', () => {
    for (const policy of Object.values(CONSOLIDATION_POLICIES)) {
      expect(policy.proposableEdges.length).toBeGreaterThan(0)
      for (const edge of policy.proposableEdges) {
        expect(EDGE_TYPES).toContain(edge)
      }
    }
  })
})
