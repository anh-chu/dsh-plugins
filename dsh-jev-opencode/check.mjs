// Self-check for the OpenCode judge adapter.
// Runnable: node check.mjs
// Uses a fake fetch, so it makes no network calls and needs no key.

import assert from 'node:assert/strict'
import { OpenCodeJudge, clampProbability, parseVerdicts } from './judge.mjs'

// ── clampProbability ────────────────────────────────────────────────────────
assert.equal(clampProbability(0.5), 0.5, 'in-range value passes through')
assert.equal(clampProbability(400), 0.99, 'a token count is clamped, not trusted')
assert.equal(clampProbability(-3), 0.01, 'negative clamps to the low end')
assert.equal(clampProbability(0), 0.01, 'exact 0 moves inward')
assert.equal(clampProbability(1), 0.99, 'exact 1 moves inward')
assert.equal(clampProbability(NaN), null, 'NaN is rejected')
assert.equal(clampProbability('0.5'), null, 'string is rejected')
assert.equal(clampProbability(undefined), null, 'undefined is rejected')

// ── parseVerdicts ───────────────────────────────────────────────────────────
const ids = ['q1', 'q2']

assert.deepEqual(
  parseVerdicts('{"answers":{"q1":{"noul":0.2},"q2":{"noul":0.8}}}', ids),
  { q1: 0.2, q2: 0.8 },
  'plain JSON',
)

assert.deepEqual(
  parseVerdicts('```json\n{"answers":{"q1":{"noul":0.3}}}\n```', ids),
  { q1: 0.3 },
  'code fences are stripped',
)

assert.deepEqual(
  parseVerdicts('Here you go: {"answers":{"q1":{"noul":0.4}}} hope that helps', ids),
  { q1: 0.4 },
  'surrounding prose is tolerated',
)

// the observed real-world failure mode
assert.deepEqual(
  parseVerdicts('{"answers":{"q1":{"noul":400},"q2":{"noul":0.7}}}', ids),
  { q1: 0.99, q2: 0.7 },
  'a returned count is clamped rather than mis-ranking',
)

assert.deepEqual(parseVerdicts('', ids), {}, 'empty content yields nothing')
assert.deepEqual(parseVerdicts('not json at all', ids), {}, 'garbage yields nothing')
assert.deepEqual(parseVerdicts('{"answers":{}}', ids), {}, 'missing ids yield nothing')

// ── OpenCodeJudge.ask against a fake transport ──────────────────────────────
let captured = null
const fakeOk = async (_url, init) => {
  captured = init
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: '{"answers":{"q1":{"noul":0.25}}}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
  }
}

const judge = new OpenCodeJudge({ apiKey: 'test-key', fetchImpl: fakeOk })
assert.equal(judge.ready, true)

const verdicts = await judge.ask('state text', { q1: 'is it true?' })
assert.deepEqual(verdicts, { q1: 0.25 })

const sent = JSON.parse(captured.body)
assert.equal(captured.headers['x-opencode-session'] !== undefined, true, 'session header is sent')
assert.equal(captured.headers.authorization, 'Bearer test-key')
assert.ok(sent.max_tokens > 400, 'max_tokens must exceed the reasoning budget')
assert.ok(
  sent.messages.some((m) => m.role === 'system' && m.content.includes('"noul"')),
  'the noul contract is in the system prompt',
)
assert.equal(judge.usage.input_tokens, 100, 'usage is accumulated')
assert.equal(judge.usage.output_tokens, 50)

// a response with no usable verdict must not look like success
const fakeEmpty = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: '' } }], usage: {} }),
})
const emptyJudge = new OpenCodeJudge({ apiKey: 'k', fetchImpl: fakeEmpty })
assert.deepEqual(await emptyJudge.ask('s', { q1: 'x' }), {}, 'empty response yields {}')
assert.ok(emptyJudge.lastError.length > 0, 'empty response records an error')

// HTTP failure propagates
const fake500 = async () => ({ ok: false, status: 500, text: async () => 'boom' })
await assert.rejects(
  () => new OpenCodeJudge({ apiKey: 'k', fetchImpl: fake500 }).ask('s', { q1: 'x' }),
  /OpenCode 500/,
)

// no questions / not ready short-circuit without a request
let called = false
const spy = async () => {
  called = true
  return { ok: true, status: 200, text: async () => '{}' }
}
assert.deepEqual(await new OpenCodeJudge({ apiKey: 'k', fetchImpl: spy }).ask('s', {}), {})
assert.equal(called, false, 'no request when there are no questions')

console.log('ok — OpenCode judge adapter checks passed')