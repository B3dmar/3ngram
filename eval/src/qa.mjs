// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA accuracy (#535): upstream's reader and judge prompts, ported
// byte for byte, plus OpenAI Batch request builders and upstream's scoring.
//
// ADVISORY ONLY, offline: this module builds requests and scores verdicts; it
// never calls a model. Ported from xiaowu0162/LongMemEval at 9e0b455:
//   src/generation/run_generation.py   prepare_prompt (orig-session, JSON
//                                      history, direct and step-by-step)
//   src/evaluation/evaluate_qa.py      get_anscheck_prompt, the yes/no label
//   src/evaluation/print_qa_metrics.py overall, task-averaged, abstention
// fixtures/qa-parity.json pins the prompts to strings upstream's code built.

import { ContentFreeError } from './content-free-error.mjs'

/**
 * Upstream's effective reader max_tokens: 800 in both modes. run_generation.py
 * means `500 if not args.cot else 800`, but `--cot` arrives as the string
 * "true" or "false", both truthy, so it is always 800 (#535 review).
 */
export const READER_MAX_TOKENS = Object.freeze({ direct: 800, cot: 800 })
export const JUDGE_MAX_TOKENS = 10
/** The judge upstream's print_qa_metrics.py requires; only its scores compare with the paper. */
export const UPSTREAM_JUDGE = 'gpt-4o-2024-08-06'
/** run_generation.py's context budget for gpt-4o: 128000 - gen_length - 1000. */
const MODEL_MAX_LENGTH = 128000

const READER_TEMPLATES = Object.freeze({
  direct:
    'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer:',
  cot: 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer (step by step):',
})

const JUDGE_HEAD =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no.'
const JUDGE_TAIL =
  '\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.'
const JUDGE_STEPS =
  ' If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.'
const JUDGE_TEMPLATES = Object.freeze({
  default: `${JUDGE_HEAD}${JUDGE_STEPS} ${JUDGE_TAIL}`,
  'temporal-reasoning': `${JUDGE_HEAD}${JUDGE_STEPS} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. ${JUDGE_TAIL}`,
  'knowledge-update': `${JUDGE_HEAD} If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.${JUDGE_TAIL}`,
  'single-session-preference':
    "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  abstention:
    'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.',
})
const DEFAULT_JUDGE_TYPES = new Set([
  'single-session-user',
  'single-session-assistant',
  'multi-session',
])

/** Python's str.format for bare {} slots, without JS replacement patterns. */
function fill(template, values) {
  const parts = template.split('{}')
  if (parts.length !== values.length + 1) throw new Error('template slot count mismatch')
  return parts.reduce((out, part, i) => out + (i === 0 ? '' : values[i - 1]) + part, '')
}

const ESCAPES = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
}

/** A JSON string as Python json.dumps writes it: everything outside space..tilde escaped, \\u in lowercase hex. */
function pyString(text) {
  let out = '"'
  for (const ch of text) {
    for (let i = 0; i < ch.length; i++) {
      const unit = ch.charCodeAt(i)
      const single = ch.length === 1 ? ch : ''
      if (ESCAPES[single]) out += ESCAPES[single]
      else if (unit >= 0x20 && unit <= 0x7e) out += single
      else out += `\\u${unit.toString(16).padStart(4, '0')}`
    }
  }
  return `${out}"`
}

/** Python json.dumps with its defaults (", " and ": " separators, ensure_ascii) for JSON-parsed values. */
export function pyJsonDumps(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return pyString(value)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('non-integer numbers are not ported')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`
  const fields = Object.entries(value).map(([k, v]) => `${pyString(k)}: ${pyJsonDumps(v)}`)
  return `{${fields.join(', ')}}`
}

/** A turn without its has_answer flag, other keys in order, as upstream pops it. */
const withoutAnswerFlag = (turn) =>
  Object.fromEntries(Object.entries(turn).filter(([key]) => key !== 'has_answer'))

/**
 * Upstream's reader prompt for a raw LongMemEval entry, `orig-session` over its
 * haystack (the oracle file holds only the evidence sessions): the latest
 * `topk` sessions, sorted by date, each as JSON with has_answer removed.
 */
export function readerPrompt(entry, { cot = false, topk = 50 } = {}) {
  const chunks = entry.haystack_sessions
    .map((session, i) => [entry.haystack_dates[i], session.map(withoutAnswerFlag)])
    .slice(-topk)
  chunks.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const history = chunks
    .map(
      ([date, session], i) =>
        `\n### Session ${i + 1}:\nSession Date: ${date}\nSession Content:\n\n${pyJsonDumps(session)}\n`,
    )
    .join('')
  // ensure_ascii keeps the history ASCII, so tokens <= characters: within this
  // bound upstream never truncates, and beyond it the port refuses.
  const budget = MODEL_MAX_LENGTH - READER_MAX_TOKENS[cot ? 'cot' : 'direct'] - 1000
  if (history.length > budget) throw new Error(`${entry.question_id}: history may need truncation`)
  return fill(READER_TEMPLATES[cot ? 'cot' : 'direct'], [
    history,
    entry.question_date,
    entry.question,
  ])
}

/** Upstream's judge prompt: abstention by question id, else by question type. */
export function judgePrompt(entry, hypothesis) {
  let template = JUDGE_TEMPLATES.abstention
  if (!entry.question_id.includes('_abs')) {
    template = DEFAULT_JUDGE_TYPES.has(entry.question_type)
      ? JUDGE_TEMPLATES.default
      : JUDGE_TEMPLATES[entry.question_type]
  }
  if (template === undefined) throw new Error(`no judge prompt for ${entry.question_type}`)
  return fill(template, [entry.question, String(entry.answer), hypothesis])
}

/** Upstream's verdict: correct when the judge's reply contains "yes". */
export const judgeLabel = (reply) => reply.trim().toLowerCase().includes('yes')

/** One /v1/chat/completions Batch request line, as upstream calls the model. */
function chatRequest(customId, model, prompt, maxTokens) {
  return {
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      n: 1,
      temperature: 0,
      max_tokens: maxTokens,
    },
  }
}

export const readerRequest = (entry, { model, cot = false }) =>
  chatRequest(
    entry.question_id,
    model,
    readerPrompt(entry, { cot }),
    READER_MAX_TOKENS[cot ? 'cot' : 'direct'],
  )

export const judgeRequest = (entry, hypothesis, { model }) =>
  chatRequest(entry.question_id, model, judgePrompt(entry, hypothesis), JUDGE_MAX_TOKENS)

/** One Batch output line as JSON; a bad line throws a content-free error, never a quote of it. */
function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    throw new ContentFreeError('batch output: a line is not valid JSON')
  }
}

/**
 * A Batch output file as custom_id -> { content, usage } or { error, usage }.
 * Usage is kept whenever the response reports it, a refusal included: it was
 * billed even when the answer is unusable.
 */
export function parseBatchOutput(jsonl) {
  const results = new Map()
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    const row = parseLine(line)
    const reported = row.response?.body?.usage
    const withUsage = (result) => (reported === undefined ? result : { ...result, usage: reported })
    const choice = row.response?.body?.choices?.[0]
    const content = choice?.message?.content
    if (row.error || row.response?.status_code !== 200 || choice === undefined) {
      const error = row.error?.code ?? row.response?.status_code ?? 'no choice'
      results.set(row.custom_id, withUsage({ error }))
    } else if (typeof content !== 'string') {
      // A refusal or a tool call answers with null content: one wrong question, not a failed file.
      results.set(
        row.custom_id,
        withUsage({ error: choice.message?.refusal ? 'refusal' : 'no content' }),
      )
    } else {
      results.set(row.custom_id, withUsage({ content: content.trim() }))
    }
  }
  return results
}

const UPSTREAM_TYPES = Object.freeze([
  'single-session-user',
  'single-session-preference',
  'single-session-assistant',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
])
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length
/**
 * numpy's round(x, 4), which print_qa_metrics.py gets by calling round() on
 * numpy floats: scale by 10^4, round half to even, scale back. toFixed rounds
 * an exact tie up instead (3/96 -> 0.0313, where upstream prints 0.0312).
 */
export function round4(value) {
  const scaled = value * 1e4
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const even = diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor
  return even / 1e4
}

/**
 * Upstream's QA metrics (print_qa_metrics.py) from `labels`, question_id ->
 * boolean: overall accuracy, the mean of the six per-type accuracies, and
 * abstention accuracy. An abstention question also counts in its own type.
 * The judge always travels with the scores, and `upstream_judge` says whether
 * they compare with the paper's: upstream refuses any other judge, while a
 * current judge is a deliberate choice for our own numbers (#535).
 */
export function qaScores(entries, labels, { judge }) {
  if (!judge) throw new Error('qaScores needs the judge model the labels came from')
  const byType = Object.fromEntries(UPSTREAM_TYPES.map((type) => [type, []]))
  const abstention = []
  for (const entry of entries) {
    if (!labels.has(entry.question_id)) continue
    const hit = labels.get(entry.question_id) ? 1 : 0
    byType[entry.question_type].push(hit)
    if (entry.question_id.includes('_abs')) abstention.push(hit)
  }
  const all = Object.values(byType).flat()
  return {
    judge,
    upstream_judge: judge === UPSTREAM_JUDGE,
    judged: all.length,
    overall_accuracy: round4(mean(all)),
    task_averaged_accuracy: round4(mean(Object.values(byType).map(mean))),
    abstention: { n: abstention.length, accuracy: round4(mean(abstention)) },
    by_type: Object.fromEntries(
      Object.entries(byType).map(([type, hits]) => [
        type,
        { n: hits.length, accuracy: round4(mean(hits)) },
      ]),
    ),
  }
}
