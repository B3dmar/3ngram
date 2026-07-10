// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

const KEY = process.env.ANTHROPIC_API_KEY
const memories = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8'))

function extractJson(text) {
  const s = text.indexOf('{'),
    e = text.lastIndexOf('}')
  return JSON.parse(text.slice(s, e + 1))
}
async function ask(prompt, retries = 3) {
  for (let a = 0; ; a++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const j = await res.json()
      return extractJson(j.content.map((c) => c.text ?? '').join(''))
    } catch (e) {
      if (a >= retries) throw e
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)))
    }
  }
}

const qPrompt = (
  m,
) => `You are building retrieval-benchmark queries. Write ONE natural question a user would ask their memory assistant that THIS memory (and ideally only this one) answers. Don't quote distinctive phrases verbatim; paraphrase the way a person recalls ("what did I decide about...", "what's the deal with..."). Output ONLY JSON: {"query": "..."}

[${m.type}] ${m.topic}
${m.content.slice(0, 900)}`

const queries = []
// 1. retrieval slice: one query per non-superseded memory (a sample of 80)
const superseded = new Set(memories.filter((m) => m.replaces).map((m) => m.replaces))
const retrievalPool = memories.filter((m) => !superseded.has(m.id))
const sample = retrievalPool
  .filter((_, i) => i % Math.ceil(retrievalPool.length / 80) === 0)
  .slice(0, 80)
for (let i = 0; i < sample.length; i += 8) {
  const batch = await Promise.all(
    sample.slice(i, i + 8).map(async (m) => {
      try {
        const { query } = await ask(qPrompt(m))
        return { slice: 'retrieval', query, expected: [m.id], forbidden: [] }
      } catch {
        return null
      }
    }),
  )
  queries.push(...batch.filter(Boolean))
  process.stdout.write(`\rretrieval ${queries.length}`)
}
// 2. supersession slice: query must surface successor, predecessor is forbidden
for (const succ of memories.filter((m) => m.replaces)) {
  const { query } = await ask(qPrompt(succ))
  queries.push({ slice: 'supersession', query, expected: [succ.id], forbidden: [succ.replaces] })
}
// 3. abstention slice: questions about domains verifiably absent
const absentTopics = [
  'kubernetes cluster migration',
  'the iOS app store rejection',
  'hiring a sales director',
  'the Tokyo office lease',
  'SOC 2 audit findings',
  'the React Native rewrite',
  'patent filing strategy',
  'the Salesforce integration outage',
  'GDPR data-deletion request from a customer',
  'the annual company retreat venue',
  'switching payroll providers',
  'the printer that keeps jamming',
]
const corpus = JSON.stringify(memories).toLowerCase()
for (const t of absentTopics) {
  const kw = t.split(' ').filter((w) => w.length > 4)
  if (kw.some((w) => corpus.includes(w.toLowerCase()))) continue // skip if any anchor word present
  queries.push({
    slice: 'abstention',
    query: `What do I know about ${t}?`,
    expected: [],
    forbidden: [],
  })
}
writeFileSync(join(fixtures, 'queries.json'), JSON.stringify(queries, null, 1))
const counts = {}
for (const q of queries) counts[q.slice] = (counts[q.slice] ?? 0) + 1
process.stdout.write(`\n${JSON.stringify(counts)}\n`)
