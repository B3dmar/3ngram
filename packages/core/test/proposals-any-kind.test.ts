// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The any-kind probe: accept/reject take a bare proposal id
// and core works out which table it belongs to, so the shipped single-id input
// contract keeps working now that there are two kinds of proposal.
//
// What matters here is the ORDER and the TERMINATION: edge table first, fact
// table only when the first reports not-found, and a not-found surfaced to the
// caller only after BOTH miss. Anything else either hides a real failure or
// makes a decision against the wrong table.
import { describe, expect, it, type Mock, vi } from 'vitest'

class ProposalNotFoundError extends Error {
  readonly proposalId: string
  constructor(proposalId: string) {
    super(`no open proposal ${proposalId} for this tenant`)
    this.name = 'ProposalNotFoundError'
    this.proposalId = proposalId
  }
}

const rejectProposal = vi.fn()
const rejectFactProposal = vi.fn()
const applyProposal = vi.fn()
const applyFactProposal = vi.fn()
const listProposals = vi.fn()
const listFactProposals = vi.fn()

vi.mock('@3ngram/db', () => ({
  ProposalNotFoundError,
  EpisodicSupersessionError: class EpisodicSupersessionError extends Error {},
  SuccessorNotLiveError: class SuccessorNotLiveError extends Error {},
  // withTenant hands the callback a marker tx; the mocks ignore it.
  withTenant: (_userId: string, fn: (tx: unknown) => unknown) => fn('tx'),
  rejectProposal: (...args: unknown[]) => rejectProposal(...args),
  rejectFactProposal: (...args: unknown[]) => rejectFactProposal(...args),
  applyProposal: (...args: unknown[]) => applyProposal(...args),
  applyFactProposal: (...args: unknown[]) => applyFactProposal(...args),
  listProposals: (...args: unknown[]) => listProposals(...args),
  listFactProposals: (...args: unknown[]) => listFactProposals(...args),
}))

const { acceptProposalAnyKind, listAllProposals, rejectProposalAnyKind } = await import(
  '../src/admin/proposals.js'
)

const USER = '00000000-0000-7000-8000-000000000001'
const ID = '019fecaa-0000-7000-8000-0000000000f1'

const edgeRow = { id: ID, status: 'rejected' }
const factRow = { id: ID, status: 'rejected' }

const reset = () => {
  for (const m of [
    rejectProposal,
    rejectFactProposal,
    applyProposal,
    applyFactProposal,
    listProposals,
    listFactProposals,
  ] as Mock[]) {
    m.mockReset()
  }
}

describe('rejectProposalAnyKind', () => {
  it('takes the edge table when it holds the id, without touching the fact table', async () => {
    reset()
    rejectProposal.mockResolvedValue(edgeRow)

    const decided = await rejectProposalAnyKind(USER, ID)

    expect(decided).toEqual({ kind: 'edge', proposal: edgeRow })
    expect(rejectFactProposal).not.toHaveBeenCalled()
  })

  it('falls through to the fact table when the edge probe reports not-found', async () => {
    reset()
    rejectProposal.mockRejectedValue(new ProposalNotFoundError(ID))
    rejectFactProposal.mockResolvedValue(factRow)

    const decided = await rejectProposalAnyKind(USER, ID)

    expect(decided).toEqual({ kind: 'fact', proposal: factRow })
    expect(rejectProposal).toHaveBeenCalled()
  })

  it('reports not-found only after BOTH tables miss', async () => {
    reset()
    rejectProposal.mockRejectedValue(new ProposalNotFoundError(ID))
    rejectFactProposal.mockRejectedValue(new ProposalNotFoundError(ID))

    await expect(rejectProposalAnyKind(USER, ID)).rejects.toBeInstanceOf(ProposalNotFoundError)
    expect(rejectFactProposal).toHaveBeenCalledOnce()
  })

  it('propagates a NON-not-found edge failure instead of probing the fact table', async () => {
    // Only "not this kind" is a reason to keep looking. Swallowing anything
    // else would turn a real failure into a confusing not-found.
    reset()
    rejectProposal.mockRejectedValue(new Error('connection reset'))

    await expect(rejectProposalAnyKind(USER, ID)).rejects.toThrow('connection reset')
    expect(rejectFactProposal).not.toHaveBeenCalled()
  })
})

describe('acceptProposalAnyKind', () => {
  it('applies an edge proposal and stamps the caller actor kind', async () => {
    reset()
    applyProposal.mockResolvedValue({ id: ID, status: 'applied' })

    const decided = await acceptProposalAnyKind(USER, ID, 'user_mcp')

    expect(decided.kind).toBe('edge_applied')
    expect(applyProposal).toHaveBeenCalledWith('tx', USER, ID, 'user_mcp')
    expect(applyFactProposal).not.toHaveBeenCalled()
  })

  it('applies a fact proposal and surfaces the materialized factId', async () => {
    reset()
    applyProposal.mockRejectedValue(new ProposalNotFoundError(ID))
    const factId = '019fecaa-0000-7000-8000-0000000000f2'
    applyFactProposal.mockResolvedValue({ proposal: { id: ID, status: 'applied' }, factId })

    const decided = await acceptProposalAnyKind(USER, ID, 'user_mcp')

    expect(decided).toMatchObject({ kind: 'fact_applied', factId })
  })

  it('propagates an edge apply refusal rather than retrying as a fact', async () => {
    // A stale-successor or episodic refusal means the edge proposal WAS found
    // and refused; probing the fact table would mask a real conflict.
    reset()
    const refusal = new Error('successor no longer live')
    applyProposal.mockRejectedValue(refusal)

    await expect(acceptProposalAnyKind(USER, ID, 'user_mcp')).rejects.toBe(refusal)
    expect(applyFactProposal).not.toHaveBeenCalled()
  })
})

describe('listAllProposals', () => {
  it('reads both kinds with the SAME per-source limit, in one tenant transaction', async () => {
    reset()
    listProposals.mockResolvedValue([edgeRow])
    listFactProposals.mockResolvedValue([factRow])

    const all = await listAllProposals(USER, { limit: 25 })

    expect(all).toEqual({ proposals: [edgeRow], factProposals: [factRow] })
    // Per-source, not a shared budget: a burst of one kind cannot starve the
    // other out of the reviewer's window.
    expect(listProposals).toHaveBeenCalledWith('tx', { limit: 25 })
    expect(listFactProposals).toHaveBeenCalledWith('tx', USER, { limit: 25 })
  })

  it('forwards a status filter to both sources, and omits it when absent', async () => {
    reset()
    listProposals.mockResolvedValue([])
    listFactProposals.mockResolvedValue([])

    await listAllProposals(USER, { status: 'proposed', limit: 10 })
    expect(listProposals).toHaveBeenCalledWith('tx', { status: 'proposed', limit: 10 })
    expect(listFactProposals).toHaveBeenCalledWith('tx', USER, { status: 'proposed', limit: 10 })

    reset()
    listProposals.mockResolvedValue([])
    listFactProposals.mockResolvedValue([])
    await listAllProposals(USER, { status: undefined, limit: 10 })
    // No undefined `status` key: the db helper lists every status when the
    // filter is absent, and an explicit undefined would not be the same thing.
    expect(listProposals).toHaveBeenCalledWith('tx', { limit: 10 })
  })
})
