// SPDX-License-Identifier: Apache-2.0

import type { GitHubEvidence } from './contract.ts'
import type { Clock } from './time.ts'
import { dayOf } from './time.ts'

// The words for a GitHub reference the binary looked up: what GitHub says of
// it, never that a commitment is done.

function githubState(g: GitHubEvidence): string {
  if (g.state === 'not_found') return 'not found or not visible'
  if (g.state !== 'closed') return g.state
  if (g.type === 'pull_request') return 'closed without merging'
  return g.stateReason === 'not_planned' ? 'closed as not planned' : 'closed'
}

// githubLabel is the detail's: the kind of reference, and when it closed.
export function githubLabel(g: GitHubEvidence, clock: Clock): string {
  if (g.state === 'not_found') return `${g.ref} ${githubState(g)}`
  const kind = g.type === 'pull_request' ? 'PR' : g.type === 'issue' ? 'issue' : 'ref'
  const at = g.state === 'merged' ? g.mergedAt : g.state === 'closed' ? g.closedAt : null
  return `${kind} ${g.ref} ${githubState(g)}${at ? ` ${dayOf(at, clock)}` : ''}`
}

// githubRowLabel is a row's: the reference as the topic wrote it (a bare #N
// stays #N, one written owner/repo#N or as a link keeps its repository) and
// its state.
export function githubRowLabel(g: GitHubEvidence): string {
  const ref = g.referenceForm === 'bare' ? g.ref.slice(g.ref.lastIndexOf('#')) : g.ref
  return `${ref} ${githubState(g)}`
}
