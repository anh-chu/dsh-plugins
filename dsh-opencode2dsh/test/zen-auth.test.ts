import test from 'node:test'
import assert from 'node:assert/strict'
import { ANONYMOUS_KEY, resolveZenApiKey } from '../src/adapter/zen-auth.ts'

const loginFile = JSON.stringify({ opencode: { type: 'api', key: 'sk-test-key' } })

test('explicit config value wins over everything', () => {
  const r = resolveZenApiKey({
    explicit: 'sk-explicit',
    env: { OPENCODE_ZEN_API_KEY: 'sk-env' },
    readAuthFile: () => loginFile,
  })
  assert.deepEqual(r, { key: 'sk-explicit', source: 'config' })
})

test('env wins over the CLI login file', () => {
  const r = resolveZenApiKey({ env: { OPENCODE_ZEN_API_KEY: 'sk-env' }, readAuthFile: () => loginFile })
  assert.deepEqual(r, { key: 'sk-env', source: 'env' })
})

test('CLI login file is used when nothing else is set', () => {
  const r = resolveZenApiKey({ env: {}, readAuthFile: (p) => {
    assert.ok(p.endsWith('opencode/auth.json'), `unexpected path: ${p}`)
    return loginFile
  } })
  assert.deepEqual(r, { key: 'sk-test-key', source: 'cli-login' })
})

test('missing login file falls back to anonymous without throwing', () => {
  const r = resolveZenApiKey({ env: {}, readAuthFile: () => { throw new Error('ENOENT') } })
  assert.deepEqual(r, { key: ANONYMOUS_KEY, source: 'anonymous' })
})

test('malformed or keyless login file falls back to anonymous', () => {
  assert.deepEqual(
    resolveZenApiKey({ env: {}, readAuthFile: () => 'not json' }),
    { key: ANONYMOUS_KEY, source: 'anonymous' },
  )
  assert.deepEqual(
    resolveZenApiKey({ env: {}, readAuthFile: () => JSON.stringify({ opencode: { type: 'api' } }) }),
    { key: ANONYMOUS_KEY, source: 'anonymous' },
  )
  assert.deepEqual(
    resolveZenApiKey({ env: {}, readAuthFile: () => JSON.stringify({ opencode: { key: '   ' } }) }),
    { key: ANONYMOUS_KEY, source: 'anonymous' },
  )
})
