// dsh-jev-opencode — point dsh-jev-prune at an OpenCode model.
//
// Why this exists:
//   dsh-jev-prune's JevClient POSTs {model, state, questions:{id:{type:'noul',
//   instructions}}} to a TypeSafe endpoint and reads back answers[id].noul.
//   `deps.judge` (index.js:568) and `fetchImpl` (jev.js:148) are function
//   parameters with no config binding, so a different backend cannot be
//   selected from cordis.yml — it must be injected here.
//
// What it does:
//   Implements the same `ask(state, questions, {signal}) -> {id: prob}` contract
//   the plugin expects, translating to/from OpenAI chat-completions on OpenCode.
//
// Two deliberate differences from a naive translation:
//   1. Clamping. OpenCode models sometimes return a count (a "400" for a
//      400-line file) instead of a probability. The plugin tests only
//      Number.isFinite (jev.js:274), so an out-of-range value would silently
//      mis-rank pruning. Values are clamped to (0,1) here.
//   2. Session header. OpenCode Go rejects requests without
//      `x-opencode-session`.
//
// Verified against a 5-run pilot: 25/25 values in range, max spread 0.20.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const OPENCODE_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
export const OPENCODE_MODEL = 'deepseek-v4-flash'

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

/**
 * Clamp into the open interval (0,1): the plugin treats 0/1 as real verdicts
 * and ranks on them, so saturation is worse than a small nudge inward.
 */
export function clampProbability(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0) return 0.01
  if (value >= 1) return 0.99
  return value
}

/** Pull answers[*].noul out of a chat completion, tolerating fences/prose. */
export function parseVerdicts(content, ids) {
  const cleaned = String(content ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return {}
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return {}
    }
  }

  const out = {}
  for (const id of ids) {
    const clamped = clampProbability(parsed?.answers?.[id]?.noul)
    if (clamped !== null) out[id] = clamped
  }
  return out
}

function readKeyFromAuth() {
  const auth = JSON.parse(readFileSync(`${homedir()}/.local/share/opencode/auth.json`, 'utf8'))
  const key = auth?.['opencode-go']?.key
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('no opencode-go key in ~/.local/share/opencode/auth.json')
  }
  return key
}

/**
 * Judge backed by an OpenCode model. Mirrors the surface dsh-jev-prune uses:
 * `ask(state, questions, {signal})`.
 */
export class OpenCodeJudge {
  constructor({
    apiKey,
    endpoint = OPENCODE_ENDPOINT,
    model = OPENCODE_MODEL,
    timeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
    sessionId = randomUUID(),
  } = {}) {
    this.apiKey = apiKey ?? readKeyFromAuth()
    this.endpoint = endpoint
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    // Stable per-process id: OpenCode Go requires it and uses it for routing.
    this.sessionId = sessionId
    this.requests = 0
    this.usage = { input_tokens: 0, output_tokens: 0 }
    this.lastError = ''
  }

  get ready() {
    return this.apiKey.length > 0 && typeof this.fetchImpl === 'function'
  }

  async ask(state, questions, options = {}) {
    const ids = Object.keys(questions ?? {})
    if (!this.ready || ids.length === 0) return {}
    if (options.signal?.aborted) throw new Error('judge aborted')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      this.requests += 1
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'x-opencode-session': this.sessionId,
        },
        body: JSON.stringify({
          model: this.model,
          // Must exceed the reasoning budget: these models bill a long
          // reasoning_content against max_tokens and return empty content
          // when the budget runs out first (observed at 400).
          max_tokens: 4000,
          messages: [
            { role: 'system', content: JUDGE_SYSTEM },
            {
              role: 'user',
              content: [
                `state:\n${state}`,
                '',
                'questions:',
                ...ids.map((id) => `${id}: ${questions[id]}`),
              ].join('\n'),
            },
          ],
        }),
        signal: controller.signal,
      })

      const text = await res.text()
      if (!res.ok) {
        this.lastError = `OpenCode ${res.status}: ${text.slice(0, 200)}`
        throw new Error(this.lastError)
      }

      const body = JSON.parse(text)
      const usage = body?.usage ?? {}
      this.usage.input_tokens += Number(usage.prompt_tokens ?? 0)
      this.usage.output_tokens += Number(usage.completion_tokens ?? 0)

      const verdicts = parseVerdicts(body?.choices?.[0]?.message?.content, ids)
      if (Object.keys(verdicts).length === 0) {
        // Surface the failure instead of letting layer 1 fall back to size
        // rules while appearing healthy.
        this.lastError = 'judge returned no usable verdicts'
      }
      return verdicts
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** Create a judge from a dsh-jev-prune `config` object. */
export function createJudgeFromConfig(config = {}) {
  const apiKey =
    typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined
  return new OpenCodeJudge({
    apiKey,
    endpoint: config.baseUrl ?? OPENCODE_ENDPOINT,
    model: config.model && config.model !== 'jev-latest' ? config.model : OPENCODE_MODEL,
  })
}