// SPDX-License-Identifier: Apache-2.0
// Human-readable formatters for each command's SDK response. The DEFAULT output
// is this scannable text; `--json` bypasses it and prints the raw SDK response.
// Output types come from @3ngram/schema (the one validation boundary) — the CLI
// invents no shape.

import type { FactsToolOutput, RememberToolOutput, SearchToolOutput } from '@3ngram/schema'

/** Format a `remember` result: the stored memory id/type/topic + embed status. */
export function formatRemember(result: RememberToolOutput): string {
  const { memory } = result
  const lines = [
    `remembered ${memory.memoryType} ${memory.id}`,
    `  topic:   ${memory.topic}`,
    `  scope:   ${memory.scope}${memory.project === null ? '' : ` / ${memory.project}`}`,
    `  embed:   ${result.embedded}`,
  ]
  if (result.commitmentId !== undefined) lines.push(`  commitment: ${result.commitmentId}`)
  return lines.join('\n')
}

/** Format `search` hits: a count header then one block per scored hit. */
export function formatSearch(result: SearchToolOutput): string {
  if (result.count === 0) return 'no matches'
  const header = `${result.count} match${result.count === 1 ? '' : 'es'}`
  const blocks = result.hits.map(
    (hit) =>
      `[${hit.score.toFixed(3)}] ${hit.memoryType} ${hit.id}\n  ${hit.topic}\n  ${hit.content}`,
  )
  return [header, ...blocks].join('\n')
}

/** Format `facts`: a count header then one line per currently-valid fact row. */
export function formatFacts(result: FactsToolOutput): string {
  if (result.count === 0) return 'no facts'
  const header = `${result.count} fact${result.count === 1 ? '' : 's'}`
  const rows = result.facts.map((fact) => {
    const confidence = fact.confidence === null ? '' : ` (${fact.confidence})`
    const until = fact.validTo === null ? '' : ` until ${fact.validTo}`
    return `${fact.subject} ${fact.predicate} ${fact.value}${confidence} [from ${fact.validFrom}${until}]`
  })
  return [header, ...rows].join('\n')
}
