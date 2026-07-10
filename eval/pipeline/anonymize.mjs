// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

const KEY = process.env.ANTHROPIC_API_KEY
const raw = readFileSync('/tmp/golden/raw.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
const idMap = new Map(raw.map((m, i) => [m.src_id, `g${String(i + 1).padStart(3, '0')}`]))

function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON object in response')
  return JSON.parse(text.slice(start, end + 1))
}

async function callOnce(m) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `Anonymize this work memory for a public benchmark dataset. Rules:
- Replace ALL person names, company/client names, emails, URLs, repo/org names, and financial figures with realistic fake equivalents (consistent style).
- Keep: dates, technical terms, tools (Postgres, GitHub...), structure, approximate length, the memory's semantic content and reasoning.
- Escape newlines inside JSON strings properly.
- Output ONLY a JSON object: {"topic": "...", "content": "..."}

topic: ${m.topic}
content: ${m.content}`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const j = await res.json()
  return extractJson(j.content.map((c) => c.text ?? '').join(''))
}

async function anonymize(m) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await callOnce(m)
      if (typeof out.topic !== 'string' || typeof out.content !== 'string')
        throw new Error('bad shape')
      return {
        id: idMap.get(m.src_id),
        type: m.type,
        topic: out.topic,
        content: out.content,
        replaces: m.replaces ? (idMap.get(m.replaces) ?? null) : null,
        created: m.created,
      }
    } catch (e) {
      if (attempt === 3) {
        process.stderr.write(`\nFAILED ${m.src_id}: ${e.message}\n`)
        return null
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

const out = []
for (let i = 0; i < raw.length; i += 8) {
  const batch = await Promise.all(raw.slice(i, i + 8).map(anonymize))
  out.push(...batch.filter(Boolean))
  process.stdout.write(`\r${Math.min(i + 8, raw.length)}/${raw.length} processed, ${out.length} ok`)
}
out.sort((a, b) => a.id.localeCompare(b.id))
// drop dangling replaces (in case a pair member failed)
const ids = new Set(out.map((m) => m.id))
for (const m of out) if (m.replaces && !ids.has(m.replaces)) m.replaces = null
writeFileSync(join(fixtures, 'golden-set.json'), JSON.stringify(out, null, 1))
process.stdout.write(
  `\nwrote ${out.length}; supersession links intact: ${out.filter((m) => m.replaces).length}` +
    '\n',
)
