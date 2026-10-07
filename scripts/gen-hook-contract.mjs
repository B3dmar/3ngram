// SPDX-License-Identifier: Apache-2.0
//
// Hook contract-constant generator.
//
// `cmd/3ngram-hook` is a separate Go binary that speaks to the REST surface, so
// it cannot import `packages/schema`. The bounds it must honour BEFORE it
// sends a request (the excerpt truncation length, the briefed-row list cap,
// the largest page sizes it asks for) and the history read's window sizes it
// reports were hand-copied into Go, which is a second copy of a number another
// package owns (AGENTS.md hard rule 2). This emits them instead.
//
// SCOPE: CONSTANTS ONLY. Regexes, uuid shape checks and enum membership are NOT
// generated and NOT duplicated — the server's Zod parse is the single validator
// for those, and a hook-side copy would be a second boundary that can disagree.
// A constant is different in kind: the hook must truncate or cap BEFORE the
// request exists, so it needs the number locally or it cannot act at all.
//
// Run it through the root pipeline, which builds the schema first:
//   pnpm run docs:generate
//
// FRESHNESS: this runs inside the root `docs:generate` script, and the
// `docs-reference` CI lane runs that script and then diffs the generated
// artifacts byte for byte — `cmd/3ngram-hook/contract_gen.go` is in that diff
// list. That lane is NOT path-gated on Go, so editing
// `packages/schema/src/agent-sessions.ts` alone is enough to go red. Same
// mechanism report-public-api.mjs uses, for the same drift class.

import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUTPUT = 'cmd/3ngram-hook/contract_gen.go'

// pnpm keeps node_modules unhoisted — resolve @3ngram/schema through a
// workspace package that declares it (no new dependency), exactly as
// report-public-api.mjs resolves typescript.
const require = createRequire(path.join(ROOT, 'apps/server/package.json'))
const schema = await import(pathToFileURL(require.resolve('@3ngram/schema')).href)
// The history read's window sizes live with the query that applies them. The
// module is imported by path (built by the docs:generate step before this
// script), not through @3ngram/db's index, which wires the database client.
const HISTORY_QUERIES = path.join(ROOT, 'packages/db/dist/memory-history-queries.js')
if (!existsSync(HISTORY_QUERIES)) {
  throw new Error(
    `${HISTORY_QUERIES} is not built; run \`pnpm run docs:generate\`, which builds it first`,
  )
}
const historyQueries = await import(pathToFileURL(HISTORY_QUERIES).href)
const SOURCES = { schema, db: historyQueries }

/**
 * The bounds the hook enforces locally, each paired with WHY it cannot simply
 * let the server reject an over-long value. Order is fixed, not sorted: it is
 * the order the constants appear in the Go file, and this file is diffed byte
 * for byte.
 */
const CONSTANTS = [
  {
    go: 'maxSessionExcerptLength',
    zod: 'MAX_SESSION_EXCERPT_LENGTH',
    why: [
      'Upper bound on `lastMessageExcerpt`. The server 400s a longer excerpt',
      "rather than deciding which half of an agent's message matters, and a 400",
      'on Stop would cost the turn its lease refresh — so the hook truncates to',
      'this before sending.',
    ],
  },
  {
    go: 'maxBriefedMemories',
    zod: 'MAX_BRIEFED_MEMORIES',
    why: [
      'Cap on the `briefedMemories` array the SessionStart open stamps. Past it',
      'the whole open 400s and the session loses its sessionRunId, so the hook',
      'stops collecting rather than trading every row for the last one.',
    ],
  },
  {
    go: 'maxBriefingSectionCeiling',
    zod: 'MAX_BRIEFING_SECTION_CEILING',
    why: [
      'Largest `sectionLimit` the briefing GET accepts. `commitments list` asks',
      'for exactly this, so `hasMore` is the only reason a row can be missing;',
      'one past it would 400 the whole read.',
    ],
  },
  {
    go: 'historyLineageNodeCap',
    zod: 'MEMORY_HISTORY_LINEAGE_NODE_LIMIT',
    source: 'db',
    why: [
      'Lineage nodes the history read returns at most. `commitments show`',
      'reports it as the window it inspected, so a none_found verdict never',
      'claims a deeper search than the server ran.',
    ],
  },
  {
    go: 'historyLineageEdgeCap',
    zod: 'MEMORY_HISTORY_LINEAGE_EDGE_LIMIT',
    source: 'db',
    why: ['Lineage edges the history read returns at most; it truncates on its own.'],
  },
  {
    go: 'historyRelationshipCap',
    zod: 'MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT',
    source: 'db',
    why: ['Direct relationships the history read returns at most (see above).'],
  },
  {
    go: 'historyEventCap',
    zod: 'MEMORY_HISTORY_EVENT_LIMIT',
    source: 'db',
    why: ['Audit events the history read returns at most (see above).'],
  },
  {
    go: 'maxRestProposalsLimit',
    zod: 'MAX_REST_PROPOSALS_LIMIT',
    why: [
      'Largest `limit` GET /api/v1/proposals accepts. `commitments show` reads',
      'this many pending proposals and reports the window it inspected, since a',
      'bounded tenant-wide list cannot prove no evidence exists.',
    ],
  },
]

function goValue(name, source = 'schema') {
  const value = SOURCES[source][name]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${source} export ${name} is not an integer constant: ${String(value)}`)
  }
  return value
}

const body = CONSTANTS.map(({ go, zod, source, why }) =>
  [`\t// ${zod}.`, ...why.map((line) => `\t// ${line}`), `\t${go} = ${goValue(zod, source)}`].join(
    '\n',
  ),
).join('\n\n')

const file = `// SPDX-License-Identifier: Apache-2.0
// Code generated by scripts/gen-hook-contract.mjs. DO NOT EDIT.
//
// The bounds cmd/3ngram-hook must honour BEFORE it builds a request body,
// mirrored from packages/schema (the single validation boundary, AGENTS.md hard
// rule 2), plus the history read's window sizes from packages/db. Regenerate
// with \`pnpm run docs:generate\`; the docs-reference CI lane diffs this file
// byte for byte, so a schema change that is not regenerated here goes red.
//
// CONSTANTS ONLY. Shape validation (agent-name kebab-case, uuid form, enum
// membership) is deliberately NOT mirrored: the server's Zod parse is the one
// validator for those, and a Go copy would be a second boundary that can
// silently disagree with it.
package main

const (
${body}
)
`

writeFileSync(path.join(ROOT, OUTPUT), file)
process.stdout.write(`${OUTPUT}: ${CONSTANTS.length} constants\n`)
