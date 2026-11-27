// SPDX-License-Identifier: Apache-2.0
// BM25 retriever for the LongMemEval advisory harness: a port of rank_bm25
// 0.2.2 BM25Okapi as LongMemEval's run_retrieval.py calls it (flat-bm25,
// session granularity). It is the retriever behind the paper's published
// BM25 baseline (Table 9), so it anchors our harness to a published number.
//
// ADVISORY ONLY, offline and deterministic: no network, no DB, no model.
// fixtures/bm25-parity.json pins the scores to values rank_bm25 itself
// produced. One known difference: upstream ranks with numpy's unstable
// argsort, so the order of exactly tied scores can differ; here ties rank the
// later haystack position first, as a reversed stable sort would.

/** rank_bm25 BM25Okapi defaults, which LongMemEval does not override. */
export const BM25_K1 = 1.5
export const BM25_B = 0.75
export const BM25_EPSILON = 0.25

/**
 * LongMemEval's session-level key: the session's user turns, joined by single
 * spaces (process_item_flat_index). Assistant turns are not indexed.
 */
export function userTurnsText(session) {
  return session.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.content)
    .join(' ')
}

/** The tokenizer LongMemEval passes rank_bm25: split on single spaces, nothing else. */
export const spaceTokens = (text) => text.split(' ')

/** Term frequencies per document, and the number of documents holding each term, in first-seen order. */
function termStats(docs) {
  const docFreqs = docs.map((doc) => {
    const frequencies = new Map()
    for (const word of doc) frequencies.set(word, (frequencies.get(word) ?? 0) + 1)
    return frequencies
  })
  const docCounts = new Map()
  for (const frequencies of docFreqs) {
    for (const word of frequencies.keys()) docCounts.set(word, (docCounts.get(word) ?? 0) + 1)
  }
  return { docFreqs, docCounts }
}

/** BM25Okapi idf: log(N - n + 0.5) - log(n + 0.5), a negative value floored at epsilon x the mean idf. */
function okapiIdf(docCounts, size, epsilon) {
  const idf = new Map()
  let idfSum = 0
  const negative = []
  for (const [word, freq] of docCounts) {
    const value = Math.log(size - freq + 0.5) - Math.log(freq + 0.5)
    idf.set(word, value)
    idfSum += value
    if (value < 0) negative.push(word)
  }
  const floor = epsilon * (idfSum / idf.size)
  for (const word of negative) idf.set(word, floor)
  return idf
}

/**
 * BM25Okapi scores of `query` (tokens) against `docs` (token arrays), with
 * rank_bm25's operation order so the float64 results match it exactly. A
 * repeated query token counts once per occurrence, as it does upstream.
 */
export function bm25Scores(docs, query, { k1 = BM25_K1, b = BM25_B, epsilon = BM25_EPSILON } = {}) {
  const size = docs.length
  const { docFreqs, docCounts } = termStats(docs)
  const idf = okapiIdf(docCounts, size, epsilon)
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / size
  const scores = new Array(size).fill(0)
  for (const term of query) {
    const termIdf = idf.get(term) ?? 0
    for (let i = 0; i < size; i++) {
      const tf = docFreqs[i].get(term) ?? 0
      scores[i] += termIdf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docs[i].length) / avgdl)))
    }
  }
  return scores
}

/** Indices by score, highest first; a tie ranks the later index first (reversed stable ascending sort). */
export function rankByScore(scores) {
  return scores.map((_, i) => i).sort((x, y) => scores[y] - scores[x] || y - x)
}

/**
 * The BM25 retriever, in the shared `{ name, rankSessions }` shape. Every
 * haystack entry is ranked, duplicates included, as upstream's corpus is.
 */
export const bm25Retriever = {
  name: 'bm25',
  async rankSessions(question, sessions) {
    const docs = sessions.map((session) => spaceTokens(userTurnsText(session)))
    const scores = bm25Scores(docs, spaceTokens(question))
    return rankByScore(scores).map((i) => ({
      session_id: sessions[i].session_id,
      score: scores[i],
    }))
  },
}
