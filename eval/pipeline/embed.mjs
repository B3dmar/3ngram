// SPDX-License-Identifier: Apache-2.0
// Embed golden set + queries with one model; cache keyed by id/query index.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

const model = process.argv[2] // openai-small | openai-large | openai-large-1536 | gemini | voyage-3-large | voyage-3-large-2048
const memories = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8'))
const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8'))

async function openaiEmbed(texts, m) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      model === 'openai-large-1536'
        ? { model: 'text-embedding-3-large', input: texts, dimensions: 1536 }
        : { model: m, input: texts },
    ),
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).data.map((d) => d.embedding)
}
async function geminiEmbed(texts, task) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${process.env.GOOGLE_AI_STUDIO_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: t }] },
          taskType: task,
          outputDimensionality: 1536,
        })),
      }),
    },
  )
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).embeddings.map((e) => e.values)
}
async function voyageEmbed(texts, isQuery) {
  const body = {
    model: 'voyage-3-large',
    input: texts,
    input_type: isQuery ? 'query' : 'document',
  }
  if (model === 'voyage-3-large-2048') body.output_dimension = 2048
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.VOYAGEAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).data.map((d) => d.embedding)
}
async function embed(texts, isQuery) {
  const out = []
  const batchSize = 64
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize)
    if (model === 'gemini')
      out.push(...(await geminiEmbed(chunk, isQuery ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT')))
    else if (model.startsWith('voyage')) out.push(...(await voyageEmbed(chunk, isQuery)))
    else
      out.push(
        ...(await openaiEmbed(
          chunk,
          model.startsWith('openai-large') ? 'text-embedding-3-large' : 'text-embedding-3-small',
        )),
      )
    process.stdout.write(`\r${Math.min(i + 64, texts.length)}/${texts.length}`)
  }
  return out
}
const memVecs = await embed(
  memories.map((m) => `${m.topic}\n${m.content}`),
  false,
)
const qVecs = await embed(
  queries.map((q) => q.query),
  true,
)
writeFileSync(
  join(fixtures, `embeddings-${model}.json`),
  JSON.stringify({
    model,
    dims: memVecs[0].length,
    memories: Object.fromEntries(memories.map((m, i) => [m.id, memVecs[i]])),
    queries: qVecs,
  }),
)
process.stdout.write(
  `\n${model}: ${memVecs.length} mem + ${qVecs.length} query vectors, ${memVecs[0].length}d\n`,
)
