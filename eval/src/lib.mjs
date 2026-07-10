// SPDX-License-Identifier: Apache-2.0
// Shared LongMemEval advisory helpers.
//
// ADVISORY ONLY: nothing here gates a PR. The blocking golden-set
// gate lives in run.mjs and is untouched.
//
// This module holds the pieces shared by the deterministic retrieval-oracle
// (longmemeval.mjs), the full-500q --download slice (download.mjs) and the
// model-judged --judge slice (judge.mjs): dataset normalization and the
// swappable lexical (token-overlap) ranker stand-in. The ranker is the
// stand-in for the live Phase 1B retriever (#77) — swap `rankSessions` when it
// lands; every caller goes through this one interface.

const STOP = new Set([
  'the',
  'a',
  'an',
  'i',
  'my',
  'me',
  'is',
  'was',
  'did',
  'do',
  'what',
  'which',
  'for',
  'to',
  'of',
  'in',
  'on',
  'and',
  'or',
  'with',
  'am',
  'are',
  'that',
  'this',
  'it',
  'about',
  'say',
  'said',
  'use',
  'using',
  'before',
  'after',
])

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w))
}

/**
 * Parse a `--name value` / `--name=value` CLI flag from an argv slice, returning
 * `fallback` when absent. Accepting BOTH forms is the whole point: the equals
 * form is documented (e.g. `--retriever=real`, `--model=…`) but the prior
 * space-only parser silently dropped it, so `--retriever=real` claimed real
 * while scoring lexical — silent metric misattribution (issue #122). The equals
 * form wins if both appear; an empty value (`--name=`) returns '' (not the
 * fallback) so an explicit-but-blank flag is caught by validation, not masked.
 */
export function parseFlag(args, name, fallback) {
  const eqPrefix = `--${name}=`
  const eqArg = args.find((a) => a.startsWith(eqPrefix))
  if (eqArg !== undefined) return eqArg.slice(eqPrefix.length)
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

export function sessionText(session) {
  return session.turns.map((t) => t.content).join(' ')
}

/**
 * Normalize the two accepted dataset shapes into a single question shape:
 *  1. This repo's subset fixture: { questions: [{ ..., haystack_sessions:
 *     [{ session_id, turns:[{role,content}] }], answer_session_ids }] }
 *  2. The official LongMemEval file (e.g. longmemeval_s.json): a TOP-LEVEL
 *     ARRAY of instances, each pairing parallel `haystack_session_ids` with
 *     `haystack_sessions` (each session an ARRAY of turn objects), plus
 *     `answer_session_ids`.
 * Both normalize to shape (1) so the subset, a hand-pointed --fixture and the
 * downloaded 500q file all measure real data instead of reporting questions: 0.
 */
export function normalizeQuestions(raw) {
  const instances = Array.isArray(raw) ? raw : (raw.questions ?? [])
  return instances.map((inst) => {
    if (Array.isArray(inst.haystack_sessions) && Array.isArray(inst.haystack_session_ids)) {
      const sessions = inst.haystack_sessions.map((turns, i) => ({
        session_id: inst.haystack_session_ids[i],
        turns,
      }))
      return { ...inst, haystack_sessions: sessions }
    }
    return inst
  })
}

/**
 * Deterministic lexical ranker (token-overlap). Stand-in for the live Phase 1B
 * retriever (#77). Ties broken by session_id for determinism.
 */
export function rankSessions(question, sessions) {
  const qTokens = new Set(tokenize(question))
  return sessions
    .map((s) => {
      const sTokens = tokenize(sessionText(s))
      let overlap = 0
      for (const t of sTokens) if (qTokens.has(t)) overlap++
      return { session_id: s.session_id, score: overlap }
    })
    .sort((a, b) => b.score - a.score || a.session_id.localeCompare(b.session_id))
}

/**
 * Recall@k / MRR for an ALREADY-RANKED session list against gold labels. Pure
 * and retriever-agnostic: both the lexical oracle and the real-retriever oracle
 * (retriever.mjs) score through this one helper so the metric math is identical
 * regardless of which retriever produced `ranked`.
 */
export function scoreRanked(ranked, answerSessionIds, k) {
  const topK = ranked.slice(0, k).map((r) => r.session_id)
  const gold = new Set(answerSessionIds)
  const hit = topK.some((id) => gold.has(id))
  let rr = 0
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i].session_id)) {
      rr = 1 / (i + 1)
      break
    }
  }
  return { ranked, hit, rr }
}

/** Recall@k / MRR over `answer_session_ids` gold labels for one question. */
export function scoreQuestion(question, k) {
  const ranked = rankSessions(question.question, question.haystack_sessions)
  return scoreRanked(ranked, question.answer_session_ids, k)
}
