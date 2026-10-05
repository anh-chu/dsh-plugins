import assert from 'node:assert'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
const lib = process.env.PLUGIN_LIB ?? `${homedir()}/.dsh/profiles/web/node_modules/dsh-opencode-session/lib/index.js`
const { patchFetch, resolveBodyRules, createQuirkStore, rejectedField } = await import(lib)

const ERR = { param: 'prompt_cache_retention', type: 'invalid_request_error',
  message: 'Upstream request failed: [unsupported_parameter] "prompt_cache_retention" is not supported by this endpoint; use "prompt_cache_options"' }
const sent = []
// Fake endpoint: glm rejects prompt_cache_retention, everything else accepts it.
const fake = async (u, i) => {
  const b = JSON.parse(i.body); sent.push(b)
  return b.model.startsWith('glm') && 'prompt_cache_retention' in b
    ? new Response(JSON.stringify(ERR), { status: 400 })
    : new Response('{"ok":true}', { status: 200 })
}
const q = createQuirkStore(undefined)
const f = patchFetch(fake, new AsyncLocalStorage(), resolveBodyRules(), q)
const call = (m, extra = {}) => f('https://opencode.ai/zen/go/v1/chat/completions',
  { body: JSON.stringify({ model: m, prompt_cache_retention: '24h', ...extra }) })

// 1. Unknown model: first try sends the field, 400 is learned, retry succeeds.
let r = await call('glm-5.3-flash'); assert.equal(r.status, 200)
assert.equal(sent.length, 2); assert.ok('prompt_cache_retention' in sent[0]); assert.ok(!('prompt_cache_retention' in sent[1]))
// 2. Learned: next call strips up front, no extra round trip.
sent.length = 0; r = await call('glm-5.3-flash'); assert.equal(r.status, 200); assert.equal(sent.length, 1)
assert.ok(!('prompt_cache_retention' in sent[0]))
// 3. Other models keep the field (DeepSeek works), no round trip wasted.
sent.length = 0; r = await call('deepseek-v4-pro'); assert.equal(sent.length, 1); assert.equal(sent[0].prompt_cache_retention, '24h')
// 4. Unrelated 400s and non-OpenCode hosts pass through untouched.
const bad = patchFetch(async () => new Response('{"error":{"message":"bad json"}}', { status: 400 }), new AsyncLocalStorage())
assert.equal((await bad('https://opencode.ai/x', { body: JSON.stringify({ model: 'm' }) })).status, 400)
sent.length = 0; await f('https://api.openai.com/v1', { body: JSON.stringify({ model: 'glm-x', prompt_cache_retention: '24h' }) })
assert.equal(sent[0].prompt_cache_retention, '24h')
// 5. Never names a field the body does not contain (no infinite loop / bogus learn).
assert.equal(rejectedField(400, JSON.stringify({ ...ERR, param: 'nope' }), { model: 'm' }), undefined)
// 5b. Message-only rejection (no `param`, no "unsupported"): the reasoning_effort 400 seen in subagents.
const RE = JSON.stringify({ type: 'invalid_request_error', message: 'Upstream request failed: [invalid_request_error] native reasoning control reasoning_effort is not allowed' })
assert.equal(rejectedField(400, RE, { model: 'm', reasoning_effort: 'high' }), 'reasoning_effort')
assert.equal(rejectedField(400, RE, { model: 'm' }), undefined)
// 5c. Core fields are never learned away, and 5xx is ignored.
assert.equal(rejectedField(400, JSON.stringify({ message: 'model is not supported' }), { model: 'm' }), undefined)
assert.equal(rejectedField(500, RE, { reasoning_effort: 'high' }), undefined)
// 5d. Transient field (reasoning_effort): retried without it, but not remembered.
{
  const seen = []; const qq = createQuirkStore(undefined)
  const g = patchFetch(async (u, i) => { const b = JSON.parse(i.body); seen.push(b)
    return 'reasoning_effort' in b ? new Response(RE, { status: 400 }) : new Response('{}', { status: 200 }) },
    new AsyncLocalStorage(), resolveBodyRules(), qq)
  const r2 = await g('https://opencode.ai/x', { body: JSON.stringify({ model: 'glm', reasoning_effort: 'high' }) })
  assert.equal(r2.status, 200); assert.equal(seen.length, 2); assert.equal(qq.fields('glm').size, 0)
}
// 6. Learned entries expire.
let t = 0; const s = createQuirkStore(undefined, () => t); s.learn('m', 'x'); assert.ok(s.fields('m').has('x'))
t = 31 * 24 * 3600 * 1000; assert.ok(!s.fields('m').has('x'))
// 7. Static rules still work.
sent.length = 0
await patchFetch(fake, new AsyncLocalStorage(), resolveBodyRules([{ model: '^kimi', drop: ['temperature'] }]), createQuirkStore(undefined))(
  'https://opencode.ai/x', { body: JSON.stringify({ model: 'kimi-k3', temperature: 1 }) })
assert.ok(!('temperature' in sent[0]))
console.log('all ok')
