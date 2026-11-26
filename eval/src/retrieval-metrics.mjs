// SPDX-License-Identifier: Apache-2.0
// LongMemEval's own session-level retrieval metrics and gold rules (#516).
//
// ADVISORY ONLY: nothing here gates a PR. Ported from upstream
// xiaowu0162/LongMemEval at 9e0b455 so a number we report is comparable with
// published ones:
//   src/retrieval/eval_utils.py      dcg, ndcg, evaluate_retrieval
//   src/retrieval/run_retrieval.py   process_item_flat_index (session level) for
//                                    the gold rule, main() for the skip rule
// fixtures/upstream-retrieval-parity.json pins the port to values upstream's
// own Python produced.

/** The cut-offs upstream's print_retrieval_metrics.py reports at session level. */
export const UPSTREAM_KS = Object.freeze([5, 10])

/**
 * Upstream's DCG: rank 1 undiscounted, then rel_p / log2(p) for 1-based p >= 2,
 * so ranks 1 and 2 weigh the same. Not the textbook log2(p + 1); kept as
 * upstream has it, or our NDCG would not compare with theirs.
 */
export function dcg(relevances, k) {
  const top = relevances.slice(0, k)
  let sum = 0
  for (let i = 0; i < top.length; i++) sum += i === 0 ? top[0] : top[i] / Math.log2(i + 1)
  return sum
}

/**
 * NDCG@k with binary gain. `corpusIds` is the question's whole haystack in
 * order, duplicates included: the ideal DCG sorts every entry's relevance.
 */
export function ndcgAny(rankedIds, gold, corpusIds, k) {
  const ideal = dcg(
    corpusIds.map((id) => (gold.has(id) ? 1 : 0)).sort((a, b) => b - a),
    k,
  )
  if (ideal === 0) return 0
  return (
    dcg(
      rankedIds.map((id) => (gold.has(id) ? 1 : 0)),
      k,
    ) / ideal
  )
}

/**
 * Upstream's evaluate_retrieval for one question at one k. An empty gold set
 * gives recall_all 1 and recall_any 0, as Python's all([]) and any([]) do.
 */
export function evaluateRetrieval(rankedIds, gold, corpusIds, k) {
  const recalled = new Set(rankedIds.slice(0, k))
  const golds = [...gold]
  return {
    recall_any: golds.some((id) => recalled.has(id)) ? 1 : 0,
    recall_all: golds.every((id) => recalled.has(id)) ? 1 : 0,
    ndcg_any: ndcgAny(rankedIds, gold, corpusIds, k),
  }
}

/** recall_all and ndcg_any at each upstream cut-off, keyed as the oracle reports them. */
export function upstreamMetrics(rankedIds, goldIds, corpusIds) {
  const gold = new Set(goldIds)
  const out = {}
  for (const k of UPSTREAM_KS) {
    const { recall_all, ndcg_any } = evaluateRetrieval(rankedIds, gold, corpusIds, k)
    out[`session_recall_all_at_${k}`] = recall_all
    out[`session_ndcg_any_at_${k}`] = ndcg_any
  }
  return out
}

const userTurnFlagged = (session) =>
  session.turns.some((turn) => turn.role === 'user' && Boolean(turn.has_answer))

/**
 * Upstream's gold rule: a haystack session whose id contains "answer" and that
 * has a user turn flagged `has_answer`. `answer_session_ids` is not consulted.
 */
export function upstreamGold(question) {
  return question.haystack_sessions
    .filter((s) => s.session_id.includes('answer') && userTurnFlagged(s))
    .map((s) => s.session_id)
}

/**
 * Upstream's skip rule: score a question only when some user turn anywhere in
 * its haystack is flagged. Evidence that sits only in assistant turns is skipped.
 */
export function hasUserTarget(question) {
  return question.haystack_sessions.some(userTurnFlagged)
}

/**
 * The gold and skip rules the oracle can score under. `answer-ids` is the
 * default: gold is the dataset's `answer_session_ids` and nothing beyond
 * abstention is skipped. `upstream` is LongMemEval's own protocol.
 */
export const PROTOCOLS = Object.freeze({
  'answer-ids': Object.freeze({ gold: (q) => q.answer_session_ids, scores: () => true }),
  upstream: Object.freeze({ gold: upstreamGold, scores: hasUserTarget }),
})
