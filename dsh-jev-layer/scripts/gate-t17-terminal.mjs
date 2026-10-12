/**
 * G-T17-1: a terminal result keeps its failure and summary lines and drops
 * ordinary passing detail.
 *
 * The fixture is one oversized `bash` log: a real failure with its stack, a run
 * summary, a slow test, a test the task names, and hundreds of lines of ordinary
 * progress. The stub judge calls every candidate unneeded, which is the
 * strongest possible pull in the wrong direction: everything the assertions
 * find in the output after that is kept by rule, not by the judge.
 *
 * Positive control first: the fixture is shown to *contain* the ordinary-detail
 * marker before the module runs, and the judge is shown to be asked exactly
 * once. Without it, "the marker is gone" would also be satisfied by an input
 * that never had one.
 *
 * Run from the repo root: node scripts/gate-t17-terminal.mjs
 */
import assert from 'node:assert/strict';
import admitTerminal from '../packages/plugin/src/modules/admit-terminal.js';
import admitOutput from '../packages/plugin/src/modules/admit-output.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

/** Ordinary progress detail: no failure, summary or test-name shape. */
function noise(index) {
  return `[build] chunk ${String(index).padStart(3, '0')} written to /tmp/out/${index}.js ${'y'.repeat(48)}`;
}
const NOISE_MARKER = '[build] chunk';

const FAILURE_LINE = '✗ retry > fails on 503';
const FAILURE_DETAIL = '  AssertionError: expected 3 to be 4';
const FAILURE_STACK = '    at retry (/home/dev/repo/src/retry.js:41:11)';
const SUMMARY_FILE = ' Test Files  1 failed | 2 passed (3)';
const SUMMARY_TESTS = '      Tests  1 failed | 2 passed (3)';
const NAMED_TEST = '✓ renders the chart (12 ms)';
const SLOW_TEST = '✓ compiles the large fixture (812 ms)';
const ORDINARY_TEST = '✓ writes the manifest (7 ms)';

/** One oversized bash log, in the order a real run produces it. */
function terminalLog() {
  const lines = [
    '$ pnpm vitest run',
    '> workspace@0.0.0 test /home/dev/repo',
    '> vitest run --reporter=verbose',
    '',
    FAILURE_LINE,
    FAILURE_DETAIL,
    FAILURE_STACK,
    '',
  ];
  for (let i = 0; i < 120; i += 1) lines.push(noise(i));
  lines.push(NAMED_TEST, SLOW_TEST, ORDINARY_TEST);
  for (let i = 0; i < 60; i += 1) lines.push(noise(1000 + i));
  // The last five lines are the run's real ending, so the module's tail floor
  // covers the summary and nothing else.
  lines.push(
    '',
    SUMMARY_FILE,
    SUMMARY_TESTS,
    '   Start at  10:14:00',
    '   Duration  1.42s (transform 300ms, setup 0ms, collect 900ms, tests 220ms)',
  );
  return lines.join('\n');
}

const LOG = terminalLog();
const CONTENT = [{ type: 'text', text: LOG }, { type: 'resource', uri: 'file:///tmp/out.txt' }];

function eventFor(name, options = {}) {
  return {
    exec: {
      name,
      callId: options.callId ?? 'call-t17-1',
      arguments: { command: 'pnpm test chart' },
    },
    result: { isError: options.isError ?? false, value: { exitCode: 1 }, content: structuredClone(CONTENT) },
  };
}

/**
 * A synthetic module context matching docs/CONTRACT.md.
 *
 * The judge answers every question it is given with `noul` (default 0.02), so a
 * line's survival can only come from the module's own rules.
 */
function makeApi(options = {}) {
  const ledger = [];
  const calls = { ask: 0, acquired: 0, asked: [] };
  const config = { enabled: true, ...(options.config ?? {}) };
  const api = {
    id: 'admit.terminal',
    config: { get: (key) => config[key] },
    judge: {
      configured: options.configured ?? true,
      ask: async (state, questions) => {
        calls.ask += 1;
        calls.asked.push({ state, questions });
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

// ── the descriptor the registry reads ─────────────────────────────────────
assert.equal(admitTerminal.id, 'admit.terminal');
assert.equal(admitTerminal.seam, SEAMS.TOOLS_POST_EXECUTE);
assert.equal(admitTerminal.seamClass, 'exclusive');
assert.deepEqual(admitTerminal.targets, ['bash', 'pwsh']);
assert.equal(admitTerminal.settings.minTokens.default, 2000);
assert.equal(typeof admitTerminal.handle, 'function');

// The two owners of tools/post-execute must not intersect, or the registry
// refuses the composition. This is the claim SPEC.md makes about the pair.
const outputTargets = new Set(admitOutput.targets);
for (const target of admitTerminal.targets) {
  assert.ok(!outputTargets.has(target), `targets are disjoint: ${target} is not admit.output's`);
}

// ── positive control: the fixture really carries ordinary detail ──────────
assert.ok(LOG.length > 2000 * 4, 'the fixture is far above the token threshold');
assert.ok(LOG.split(NOISE_MARKER).length - 1 > 100, 'the input has more than 100 ordinary-detail lines');

// ── the module prunes it, judged through api.judge ────────────────────────
{
  const { api, ledger, calls } = makeApi();
  const event = eventFor('bash');
  const before = structuredClone(event.result);
  const out = await admitTerminal.handle(event, api);

  assert.ok(out, 'a judge that answers lets the module return a replacement');
  assert.equal(calls.ask, 1, 'exactly one judge request went out');
  assert.ok(calls.acquired >= 1, 'the budget was asked for one unit');
  assert.deepEqual(event.result, before, 'the input result was not mutated');

  const text = out.content[0].text;
  // The judge called every candidate unneeded, so ordinary detail must be gone.
  assert.ok(!text.includes(NOISE_MARKER), 'ordinary passing detail was dropped');
  assert.ok(text.split('\n').length < LOG.split('\n').length / 4, 'the log is a fraction of its size');
  // And the materials the task needs must survive, kept by rule.
  assert.ok(text.includes(FAILURE_LINE), 'the failing test name survived');
  assert.ok(text.includes(FAILURE_DETAIL), 'the failure detail survived');
  assert.ok(text.includes(FAILURE_STACK), 'the stack frame after the failure survived');
  assert.ok(text.includes(SUMMARY_FILE), 'the file summary survived');
  assert.ok(text.includes(SUMMARY_TESTS), 'the test summary survived');
  assert.ok(text.includes(NAMED_TEST), 'the test the task names survived');
  assert.ok(text.includes(SLOW_TEST), 'the slow test survived');
  assert.ok(/… \d+ lines omitted …/.test(text), 'each dropped run is marked');
  // The one fast, unanchored, ordinary passing test was the judge's to decide.
  assert.ok(!text.includes(ORDINARY_TEST), 'an unanchored fast passing test was judged away');

  // Non-text blocks survive the rewrite, and the value-shaped fields stay.
  assert.equal(out.content.length, 2, 'the resource block came through');
  assert.equal(out.content[1].uri, 'file:///tmp/out.txt');
  assert.deepEqual(out.value, { exitCode: 1 });

  // The ledger holds the decision under this module's own feature id.
  assert.equal(ledger.length, 1, 'one decision was recorded');
  assert.equal(ledger[0].featureId, 'admit.terminal');
  assert.equal(ledger[0].callId, 'call-t17-1');
  assert.equal(ledger[0].decision, 'prune');
  assert.equal(ledger[0].mode, 'enforce');
  assert.equal(ledger[0].probabilities.length, Object.keys(calls.asked[0].questions).length);
}

// ── pwsh is the other target, not a special case on the side ──────────────
{
  const { api, ledger } = makeApi();
  const out = await admitTerminal.handle(eventFor('pwsh', { callId: 'call-t17-pwsh' }), api);
  assert.ok(out, 'a pwsh result is admitted too');
  assert.ok(!out.content[0].text.includes(NOISE_MARKER), 'pwsh ordinary detail was dropped');
  assert.ok(out.content[0].text.includes(FAILURE_LINE), 'pwsh failure lines survived');
  assert.equal(ledger[0].featureId, 'admit.terminal');
}

// ── a failing run is the main input, so isError does not skip it ──────────
{
  const { api, calls } = makeApi();
  const out = await admitTerminal.handle(eventFor('bash', { isError: true, callId: 'call-t17-err' }), api);
  assert.ok(out, 'an errored terminal result is still admitted');
  assert.equal(calls.ask, 1, 'its ordinary detail was judged');
  const text = out.content[0].text;
  assert.ok(!text.includes(NOISE_MARKER), 'ordinary detail was dropped from the failing run');
  assert.ok(text.includes(FAILURE_LINE), 'its failure line survived');
}

// ── the registry shape returns a decision, not a result ───────────────────
{
  const { api, ledger } = makeApi();
  const downstream = {
    kind: 'accept',
    content: structuredClone(CONTENT),
    additionalContexts: [{ text: 'keep' }],
  };
  let nextCalls = 0;
  const out = await admitTerminal.handle(
    eventFor('bash').exec,
    api,
    async () => {
      nextCalls += 1;
      return downstream;
    },
  );
  assert.equal(nextCalls, 1, 'the downstream decision was taken once');
  assert.equal(out.kind, 'accept', 'a decision is handed back');
  assert.ok(!out.content[0].text.includes(NOISE_MARKER), 'the decision carries the pruned log');
  assert.ok(out.content[0].text.includes(FAILURE_LINE), 'the decision keeps the failure');
  assert.deepEqual(out.additionalContexts, [{ text: 'keep' }], 'nothing else was dropped');
  assert.equal(ledger[0].decision, 'prune');
}

// ── a log with nothing to judge is left alone and costs no request ────────
{
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`✗ case ${i} failed on 503`);
    lines.push(`    at step (/home/dev/repo/src/worker.js:${i}:1)`);
  }
  const protectedOnly = {
    exec: { name: 'bash', callId: 'call-t17-none', arguments: { command: 'pnpm test' } },
    result: { isError: false, content: [{ type: 'text', text: `${lines.join('\n')}\n` }] },
  };
  assert.ok(lines.join('\n').length > 2000 * 4, 'the protected-only fixture is above the threshold');
  const { api, calls } = makeApi();
  const out = await admitTerminal.handle(protectedOnly, api);
  assert.equal(out, undefined, 'every line was protected, so nothing is rewritten');
  assert.equal(calls.ask, 0, 'and no request was paid for');
  assert.equal(calls.acquired, 0, 'and no budget unit was spent');
}

// ── a log of passing PER-TEST lines is judged, not wholly protected ─────────
// `PASS test_500 ok 3ms` is a per-test line, not a summary. A bare `^PASS` summary
// pattern protected all of them, so nine hundred passes left no candidate and the
// judge was never asked — found on a real headless turn whose ledger stayed empty,
// which no fixture caught because every fixture used a different passing glyph.
{
  const lines = [];
  for (let i = 0; i < 900; i += 1) lines.push(`PASS test_${i} ok 3ms`);
  lines.push('FAIL test_payment_refund expected 200 got 500');
  lines.push('summary: 900 passed, 1 failed');
  const perTest = {
    exec: { name: 'bash', callId: 'call-t17-passlines', arguments: { command: 'cat build.log' } },
    result: { isError: false, content: [{ type: 'text', text: `${lines.join('\n')}\n` }] },
  };
  const { api, calls } = makeApi({ shadow: true });
  await admitTerminal.handle(perTest, api);
  assert.ok(calls.ask >= 1, 'a log of passing per-test lines reaches the judge');

  // A runner's FILE-level result is still a summary and stays protected.
  const fileLevel = [];
  for (let i = 0; i < 400; i += 1) fileLevel.push(`PASS src/suite${i}.test.js (1.${i % 10} s)`);
  const protectedFiles = {
    exec: { name: 'bash', callId: 'call-t17-filelevel', arguments: { command: 'pnpm test' } },
    result: { isError: false, content: [{ type: 'text', text: `${fileLevel.join('\n')}\n` }] },
  };
  const second = makeApi({ shadow: true });
  await admitTerminal.handle(protectedFiles, second.api);
  assert.equal(second.calls.ask, 0, 'file-level PASS lines are summaries and need no request');
}

console.log('GATE-T17-TERMINAL-OK');
