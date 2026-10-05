// Jev-on-OpenCode pilot.
//
// Question: can an OpenCode model answer dsh-jev-prune's `noul` questions with
// probabilities reliable enough to drive keepThreshold / pressure ranking?
//
// The plugin's own client cannot be reused here: it POSTs
// {model, state, questions:{id:{type:'noul',instructions}}} and reads back
// answers[id].noul. OpenCode speaks OpenAI chat-completions, so this script
// performs the translation and measures what comes back.
//
// Run: node pilot.mjs
//
// No dependencies. Reads the OpenCode Go key from the OpenCode auth store.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const AUTH_PATH = `${homedir()}/.local/share/opencode/auth.json`
const ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
const MODEL = 'deepseek-v4-flash'

/**
 * OpenCode Go refuses requests without a session id header.
 * Reuse one id per process so the router can keep a stable route.
 */
const SESSION_ID = randomUUID()

const JUDGE_SYSTEM = [
  'You are a calibration judge for a context-compaction system.',
  'You will receive a session state and a list of numbered statements.',
  'For each statement return your probability that it is TRUE.',
  '',
  'Rules:',
  '- probabilities MUST be numbers strictly between 0 and 1 (use 0.01..0.99)',
  '- NEVER return a count, a size in bytes/lines/tokens, or any value >= 1',
  '- answer EVERY id exactly once, echoing the id as given',
  '- output JSON only, no prose, no code fences',
  '',
  'Exact output shape:',
  '{"answers":{"<id>":{"noul":<probability>}}}',
].join('\n')

function readKey() {
  const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
  const key = auth?.['opencode-go']?.key
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`no opencode-go key in ${AUTH_PATH}`)
  }
  return key
}

async function ask(key, state, questions) {
  const body = {
    model: MODEL,
    // deepseek-v4-flash emits a long reasoning_content before the answer and
    // that reasoning is billed against max_tokens: at 400 the whole budget was
    // consumed by reasoning and `content` came back as an empty string.
    max_tokens: 4000,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: [
          `state:\n${state}`,
          '',
          'questions:',
          ...Object.entries(questions).map(([id, text]) => `${id}: ${text}`),
        ].join('\n'),
      },
    ],
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-opencode-session': SESSION_ID,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)

  const parsed = JSON.parse(text)
  const content = parsed?.choices?.[0]?.message?.content ?? ''
  return { content, usage: parsed?.usage ?? {} }
}

/** Strip code fences, then read answers[id].noul as a number. */
export function parseVerdicts(content, ids) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // The model may wrap the object in prose; take the outermost braces.
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return { verdicts: {}, parseError: 'not JSON' }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return { verdicts: {}, parseError: 'not JSON' }
    }
  }

  const verdicts = {}
  for (const id of ids) {
    const value = parsed?.answers?.[id]?.noul
    if (typeof value === 'number' && Number.isFinite(value)) verdicts[id] = value
  }
  return { verdicts, parseError: null }
}

// ── the pilot ───────────────────────────────────────────────────────────────

// The plugin does not judge against a bare line: state.js builds each result
// line with an excerpt (resultExcerptChars, default 240) plus surrounding
// session context. An earlier version of this pilot used a single terse line
// and the model flapped between opposite verdicts — the fixture was the fault,
// not the model. This mirrors the real shape.
const STATE = [
  'session: coding agent, 41 events, 62% of a 200k window used',
  'task: fix the 404 returned by POST /api/orders in src/router.ts',
  '',
  'e1 tool_result read src/router.ts (612 lines)',
  '  excerpt: import { Router } from "express"; const router = Router();',
  '  router.post("/api/orders", async (req, res) => { const order = await create(req.body);',
  '  res.json(order); }); export default router;',
  'e2 tool_result grep "handleRequest" (18 matches)',
  '  excerpt: src/router.ts:14: export function handleRequest(req, res) { ... }',
  '  src/router.ts:88:   return handleRequest(req, res)',
  'e3 assistant: "the failure is that handleRequest never awaits create(); I have the',
  '  router contents in e1 and the call sites from e2, so I can patch it now"',
  'e4 tool_result read src/router.ts (612 lines)',
  '  excerpt: import { Router } from "express"; const router = Router();',
  '  router.post("/api/orders", async (req, res) => { const order = await create(req.body);',
  '  res.json(order); }); export default router;',
  'e5 tool_result bash "pnpm test" (SUCCESS, 240 lines)',
  '  excerpt: PASS test/router.test.ts  ✓ 12 tests passed',
  'e6 user: "same 404 again after the patch"',
].join('\n')

const QUESTIONS = {
  q1: 'Tool result e1 is stale: its content is already superseded or captured elsewhere.',
  q2: 'Tool result e1 is still needed to continue the task.',
  q3: 'Tool result e2 (grep output) can be pruned without losing decision-relevant information.',
  q4: 'Tool result e5 contains error or failure evidence and must not be pruned.',
  q5: 'Tool result e4 is redundant with e1.',
}

const RUNS = 5

function bucket(p) {
  if (p < 0 || p > 1) return 'OUT_OF_RANGE'
  if (p === 0 || p === 1) return 'BOUNDARY'
  return 'IN_RANGE'
}

async function main() {
  const key = readKey()
  console.log(`endpoint : ${ENDPOINT}`)
  console.log(`model    : ${MODEL}`)
  console.log(`runs     : ${RUNS}\n`)

  const ids = Object.keys(QUESTIONS)
  const history = Object.fromEntries(ids.map((id) => [id, []]))
  let requests = 0
  let failures = 0
  let unparseable = 0
  // A response can be valid JSON for some questions and silently omit others.
  // The plugin drops missing ids (jev.js:274), so an omission is a real loss of
  // ranking signal and must be counted, not scored as a clean run.
  let droppedAnswers = 0
  let incompleteRuns = 0

  for (let run = 1; run <= RUNS; run += 1) {
    let content
    try {
      const res = await ask(key, STATE, QUESTIONS)
      content = res.content
      requests += 1
    } catch (error) {
      failures += 1
      console.log(`run ${run}: REQUEST FAILED — ${error.message}`)
      continue
    }

    const { verdicts, parseError } = parseVerdicts(content, ids)
    if (parseError) unparseable += 1

    const missing = ids.filter((id) => !(id in verdicts))
    droppedAnswers += missing.length
    if (missing.length > 0) incompleteRuns += 1

    const shown = ids
      .map((id) => (id in verdicts ? `${id}=${verdicts[id]}` : `${id}=MISSING`))
      .join('  ')
    console.log(`run ${run}: ${shown}`)
    if (missing.length > 0) {
      console.log(`         dropped ${missing.length}/${ids.length} (${missing.join(', ')})`)
    }
    if (Object.keys(verdicts).length === 0) {
      console.log(`         raw: ${content.slice(0, 160).replace(/\n/g, ' ')}`)
    }

    for (const id of ids) {
      if (id in verdicts) history[id].push(verdicts[id])
    }
  }

  console.log('\n── per-question stability ──')
  let outOfRange = 0
  let boundary = 0
  let total = 0
  let maxSpread = 0

  for (const id of ids) {
    const values = history[id]
    if (values.length === 0) {
      console.log(`${id}: no values`)
      continue
    }
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const spread = hi - lo
    maxSpread = Math.max(maxSpread, spread)
    for (const v of values) {
      total += 1
      const b = bucket(v)
      if (b === 'OUT_OF_RANGE') outOfRange += 1
      if (b === 'BOUNDARY') boundary += 1
    }
    console.log(
      `${id}: min=${lo} max=${hi} mean=${mean.toFixed(3)} spread=${spread.toFixed(3)} n=${values.length}`,
    )
  }

  console.log('\n── summary ──')
  console.log(`requests ok          : ${requests}/${RUNS}`)
  console.log(`request failures     : ${failures}`)
  console.log(`unparseable payloads : ${unparseable}`)
  console.log(`values collected     : ${total}/${RUNS * ids.length}`)
  console.log(`dropped answers      : ${droppedAnswers} (in ${incompleteRuns}/${requests} runs)`)
  console.log(`out-of-range (<0,>1) : ${outOfRange}`)
  console.log(`boundary (0 or 1)    : ${boundary}`)
  console.log(`max spread           : ${maxSpread.toFixed(3)}`)

  const expected = RUNS * ids.length
  const verdict =
    total === 0
      ? 'FAIL — no usable values at all (every response was empty or unparseable)'
      : failures > 0 || unparseable > 0
        ? 'FAIL — some requests failed or returned unparseable payloads'
        : droppedAnswers > expected * 0.1
          ? `FAIL — ${droppedAnswers}/${expected} answers silently dropped; a dropped id loses ranking signal`
          : outOfRange > 0
            ? 'FAIL — model emits non-probabilities; needs clamping and a tighter prompt'
            : boundary > total / 3
              ? 'WEAK — mostly saturated at 0/1; ranking signal is coarse'
              : maxSpread > 0.4
                ? 'WEAK — high run-to-run variance; unreliable ordering'
                : droppedAnswers > 0
                  ? 'PASS (with drops) — in-range and stable, but some answers were omitted'
                  : 'PASS — in-range and reasonably stable'
  console.log(`\nverdict: ${verdict}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}