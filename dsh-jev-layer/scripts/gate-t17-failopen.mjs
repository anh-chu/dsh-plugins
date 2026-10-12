/**
 * G-T17-2: a non-terminal result and a judge failure both leave the result
 * unchanged.
 *
 * Every path that cannot produce a trustworthy selection must return the result
 * untouched. Pruning is an optimisation; it must never be why a task failed.
 *
 * The gate opens with a positive control: the same fixture, driven through the
 * same `handle()`, IS pruned when the judge answers. Without it, "unchanged"
 * would also be satisfied by a module that never prunes anything at all.
 *
 * Run from the repo root: node scripts/gate-t17-failopen.mjs
 */
import assert from 'node:assert/strict';
import admitTerminal from '../packages/plugin/src/modules/admit-terminal.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const NOISE_MARKER = '[run] step';
const FAILURE_LINE = 'FAIL src/api.test.js';
const FAILURE_DETAIL = '  AssertionError: 500 !== 200';
const SUMMARY_FILES = ' Test Files  1 failed | 149 passed (150)';
const SUMMARY_LINE = '      Tests  1 failed, 149 passed, 150 total';
const SUMMARY_DURATION = '   Duration  2.31s (tests 1.10s)';

/** One oversized bash log: a real failure, ordinary detail, and a summary. */
function terminalLog(noiseLines = 150) {
  const lines = ['$ pnpm test', '', FAILURE_LINE, FAILURE_DETAIL, '    at api (/home/dev/repo/src/api.js:12:3)', ''];
  for (let i = 0; i < noiseLines; i += 1) lines.push(`${NOISE_MARKER} ${i} ok ${'z'.repeat(50)}`);
  // The last five lines are the run's real ending, so the module's tail floor
  // covers the summary and nothing else.
  lines.push('', SUMMARY_FILES, SUMMARY_LINE, SUMMARY_DURATION, '');
  return lines.join('\n');
}

const LOG = terminalLog();
const CONTENT = [{ type: 'text', text: LOG }];

/** A result that exceeds the default 2000-token threshold. */
function bigEvent(name, options = {}) {
  return {
    exec: { name, callId: options.callId ?? 'call-t17-2', arguments: { command: 'pnpm test api' } },
    result: { isError: false, value: { exitCode: 1 }, content: structuredClone(CONTENT) },
  };
}

/** A synthetic module context matching docs/CONTRACT.md. */
function makeApi(options = {}) {
  const ledger = [];
  const calls = { ask: 0, acquired: 0 };
  const config = { enabled: true, ...(options.config ?? {}) };
  const api = {
    id: 'admit.terminal',
    config: { get: (key) => config[key] },
    judge: {
      configured: options.configured ?? true,
      ask: async (state, questions) => {
        calls.ask += 1;
        if (options.throws) throw new Error('judge transport failed');
        if ('answers' in options) return options.answers;
        return Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: options.noul ?? 0.02 }]),
        );
      },
    },
    budget: {
      tryAcquire: () => {
        calls.acquired += 1;
        if (options.budgetThrows) throw new Error('budget unavailable');
        return options.acquire === undefined ? true : options.acquire;
      },
    },
    ledger: { append: (entry) => ledger.push(entry) },
    shadow: { isShadow: () => options.shadow === true },
    notice: { request: () => 'accepted' },
    notifications: { send: async () => 'sent' },
    log: { warn: () => {} },
    registerAgent: () => () => {},
    seams: SEAMS,
  };
  return { api, ledger, calls };
}

/** Drive the packed contract form and assert the caller keeps the original. */
async function assertUnchangedPacked(label, api, event) {
  const before = structuredClone(event.result);
  const out = await admitTerminal.handle(event, api);
  assert.equal(out, undefined, `${label}: the module returned no replacement`);
  assert.deepEqual(event.result, before, `${label}: the input result was not mutated`);
  assert.equal(event.result.content[0].text, LOG, `${label}: every line is still there`);
  assert.ok(event.result.content[0].text.includes(NOISE_MARKER), `${label}: the ordinary detail is still there`);
}

/** Drive the registry form and assert the downstream decision comes back. */
async function assertUnchangedRegistry(label, api, name = 'bash') {
  const downstream = { kind: 'accept', content: structuredClone(CONTENT), additionalContexts: [{ text: 'x' }] };
  let nextCalls = 0;
  const out = await admitTerminal.handle(bigEvent(name).exec, api, async () => {
    nextCalls += 1;
    return downstream;
  });
  assert.equal(nextCalls, 1, `${label}: the downstream decision was taken once`);
  assert.equal(out, downstream, `${label}: the downstream decision is handed back unchanged`);
  assert.equal(out.content[0].text, LOG, `${label}: every line is still there`);
  assert.equal(out.additionalContexts.length, 1, `${label}: nothing else was dropped either`);
}

// ── positive control: the detector is honest, the same fixture does prune ──
{
  const { api, ledger, calls } = makeApi();
  const event = bigEvent('bash');
  assert.ok(LOG.includes(NOISE_MARKER), 'positive control: the fixture carries ordinary detail');
  const out = await admitTerminal.handle(event, api);
  assert.notEqual(out, undefined, 'positive control: a judge that answers does prune this fixture');
  assert.ok(!out.content[0].text.includes(NOISE_MARKER), 'positive control: the ordinary detail was dropped');
  assert.ok(out.content[0].text.includes(FAILURE_LINE), 'positive control: the failure survived');
  assert.ok(out.content[0].text.includes(SUMMARY_LINE), 'positive control: the summary survived');
  assert.equal(calls.ask, 1, 'positive control: one judge request went out');
  assert.equal(ledger.length, 1, 'positive control: the decision was recorded');
  assert.equal(ledger[0].decision, 'prune');
}

// ── a non-terminal result is never this module's to touch ─────────────────
for (const name of ['read', 'grep', 'glob', 'web_fetch', 'web_search', 'node', 'terminal_read']) {
  const { api, calls, ledger } = makeApi();
  const event = bigEvent(name);
  await assertUnchangedPacked(`tool "${name}"`, api, event);
  assert.equal(calls.ask, 0, `tool "${name}": no judge request was made`);
  assert.equal(calls.acquired, 0, `tool "${name}": no budget unit was spent`);
  assert.equal(ledger.length, 0, `tool "${name}": nothing was recorded`);
}
{
  const { api, calls } = makeApi();
  await assertUnchangedRegistry('a non-terminal result in the registry shape', api, 'read');
  assert.equal(calls.ask, 0, 'a non-terminal result costs no request');
}

// ── a result at or below the threshold is left alone ─────────────────────
{
  const shortLog = terminalLog(20);
  const event = {
    exec: { name: 'bash', callId: 'call-t17-short', arguments: { command: 'pnpm test api' } },
    result: { isError: false, content: [{ type: 'text', text: shortLog }] },
  };
  assert.ok(shortLog.length < 2000 * 4, 'the short fixture is below the token threshold');
  const { api, calls } = makeApi();
  const out = await admitTerminal.handle(event, api);
  assert.equal(out, undefined, 'a small result is not rewritten');
  assert.equal(calls.ask, 0, 'a small result costs no request');
}
{
  const { api, calls } = makeApi({ config: { minTokens: 1_000_000 } });
  await assertUnchangedPacked('a raised minTokens', api, bigEvent('bash'));
  assert.equal(calls.ask, 0, 'a raised threshold costs no request');
}

// ── fail-open path 1: the judge returns null (unavailable) ────────────────
{
  const { api } = makeApi({ answers: null });
  await assertUnchangedPacked('judge returns null', api, bigEvent('bash'));
}
{
  const { api } = makeApi({ answers: null });
  await assertUnchangedRegistry('registry shape, judge returns null', api);
}

// ── fail-open path 2: the judge throws ────────────────────────────────────
{
  const { api } = makeApi({ throws: true });
  await assertUnchangedPacked('judge throws', api, bigEvent('bash'));
}
{
  const { api } = makeApi({ throws: true });
  await assertUnchangedRegistry('registry shape, judge throws', api);
}

// ── fail-open path 3: no judge is configured, so nothing is asked ─────────
{
  const { api, calls } = makeApi({ configured: false });
  await assertUnchangedPacked('judge unconfigured', api, bigEvent('bash'));
  assert.equal(calls.ask, 0, 'an unconfigured judge costs no request');
  assert.equal(calls.acquired, 0, 'and no budget unit');
}

// ── fail-open path 4: an unreadable answer is a failure, not a zero ───────
{
  const { api } = makeApi({ answers: { c0: { type: 'noul', noul: 0.02 } } });
  await assertUnchangedPacked('a missing answer for a later candidate', api, bigEvent('bash'));
}
{
  const { api } = makeApi({ answers: 'not an answer map' });
  await assertUnchangedPacked('a non-object answer map', api, bigEvent('bash'));
}
{
  const { api } = makeApi({ noul: 'very unneeded' });
  await assertUnchangedPacked('a wrongly-typed probability', api, bigEvent('bash'));
}

// ── fail-open path 5: the budget refuses ──────────────────────────────────
{
  const { api, calls } = makeApi({ acquire: false });
  await assertUnchangedPacked('budget refuses', api, bigEvent('bash'));
  assert.equal(calls.ask, 0, 'a refused budget costs no request');
}
{
  const { api } = makeApi({ acquire: false });
  await assertUnchangedRegistry('registry shape, budget refuses', api);
}

// ── fail-open path 6: an unexpected throw anywhere is contained ───────────
{
  const { api } = makeApi({ budgetThrows: true });
  await assertUnchangedPacked('the budget throws', api, bigEvent('bash'));
}
{
  const { api } = makeApi({ budgetThrows: true });
  await assertUnchangedRegistry('registry shape, the budget throws', api);
}

// ── shadow mode records the would-be decision and changes nothing ─────────
{
  const { api, ledger, calls } = makeApi({ shadow: true });
  await assertUnchangedPacked('shadow mode', api, bigEvent('bash'));
  assert.equal(calls.ask, 1, 'shadow mode still pays for the judgment it records');
  assert.equal(ledger.length, 1, 'the would-be decision was recorded');
  assert.equal(ledger[0].featureId, 'admit.terminal');
  assert.equal(ledger[0].decision, 'shadow');
  assert.equal(ledger[0].wouldBe, 'prune');
  assert.equal(ledger[0].mode, 'shadow');
}
{
  const { api, ledger } = makeApi({ shadow: true });
  await assertUnchangedRegistry('registry shape, shadow mode', api);
  assert.equal(ledger[0].decision, 'shadow');
}

// ── the registry's promise: a throw never leaves the hook unanswered ──────
{
  const { api } = makeApi({ budgetThrows: true });
  const downstream = { kind: 'accept', content: structuredClone(CONTENT) };
  const out = await admitTerminal.handle(bigEvent('bash').exec, api, async () => downstream);
  assert.equal(out, downstream, 'an unexpected throw still hands the downstream decision back');
}

console.log('GATE-T17-FAILOPEN-OK');
