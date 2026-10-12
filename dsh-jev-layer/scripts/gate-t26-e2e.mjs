/**
 * Gate G-T26-1: the plugin's own wiring, end to end, without a host.
 *
 * Why this gate exists. The module gates drive a synthetic `api` object, which
 * is what let several agents work in parallel and also what hid a credential that
 * never resolved. Nothing so far proved the chain that actually matters:
 *
 *   config -> registry listener -> module handle -> real core -> judge -> ledger file
 *
 * This gate walks that chain with the REAL registry, the REAL shipped module
 * list, and the REAL core. Only the judge transport is stubbed, so no network and
 * no credential are involved. It asserts the artifact the outcome names: the
 * transformed result the harness would receive, and a record on disk.
 *
 * Run: node scripts/gate-t26-e2e.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import modules from '../packages/plugin/src/modules/index.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

/** A fake host context that captures the listeners the registry registers. */
function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(seam, fn) {
      listeners.set(seam, fn);
      return () => listeners.delete(seam);
    },
    get: () => undefined,
    inject: () => () => {},
    effect: (fn) => {
      fn();
      return () => {};
    },
    logger: { warn() {}, info() {} },
  };
}

/**
 * A stub System One transport. Every question gets a probability derived from a
 * counter, so some chunks are kept and some are dropped: a gate that always kept
 * everything, or always dropped everything, could not produce the assertion below.
 */
function judgeStub() {
  let n = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const id of Object.keys(body.questions ?? {})) {
      n += 1;
      answers[id] = { noul: n % 3 === 0 ? 0.95 : 0.05 };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ model: 'stub', answers }),
    };
  };
}

const SEGMENT = (i) => `SEG${i} ${'filler '.repeat(40)}`;
// Blank-line separated on purpose: the module chunks on paragraph boundaries, so
// a single-newline fixture would be one chunk and could never be pruned.
const BIG_TEXT = Array.from({ length: 12 }, (_, i) => SEGMENT(i)).join('\n\n');

const EXEC = { name: 'read', callId: 'call-e2e-1', args: { path: '/tmp/big.txt' } };
const RESULT = {
  isError: false,
  value: { bytes: BIG_TEXT.length },
  content: [{ type: 'text', text: BIG_TEXT }],
};

const settingsFor = (mode) => ({
  get: (key) =>
    ({ mode, turnCeiling: 200, endpoint: 'https://stub.invalid/v1/systemone', model: 'stub' })[key],
});

const dir = mkdtempSync(join(tmpdir(), 'jev-e2e-'));
const ledgerPath = join(dir, 'ledger.jsonl');

/** Build a registry with the real module list and the real core. */
async function harness({ mode, enabled }) {
  const core = createCore({
    settings: settingsFor(mode),
    fetchImpl: judgeStub(),
    now: () => 1_000,
    apiKey: 'stub-key',
    statePath: ledgerPath,
  });
  const ctx = fakeCtx();
  const config = enabled ? { 'admit.output': { enabled: true, minTokens: 200 } } : {};
  const registry = createRegistry({ modules, ctx, config, core });
  await registry.start();
  return { core, ctx, registry };
}

function ledgerRows() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

try {
  // 1. POSITIVE CONTROL for the listener itself: with every module off there is
  //    no listener on the seam, so a gate that "passed" by finding one could not.
  {
    const { ctx, registry } = await harness({ mode: 'enforce', enabled: false });
    assert.equal(
      ctx.listeners.has(SEAMS.TOOLS_POST_EXECUTE),
      false,
      'control: no module enabled means no listener on tools/post-execute',
    );
    await registry.stop();
  }

  // 2. ENFORCE: the real chain transforms the result and writes a record on disk.
  {
    const { ctx, registry } = await harness({ mode: 'enforce', enabled: true });
    const listener = ctx.listeners.get(SEAMS.TOOLS_POST_EXECUTE);
    assert.equal(
      typeof listener,
      'function',
      'an enabled admit.output registers the seam listener through the registry',
    );

    // The HARNESS calls this seam as `(exec, result, next)` — see the seam
    // catalogue's signature and `dsh-tools`' `postExecute`, whose inner `next`
    // accepts the result unchanged. Calling the listener with two arguments and no
    // continuation is the one shape the harness never uses, and this gate used to
    // do exactly that: it certified a packing rule that discarded the result in
    // production. The continuation is passed here for that reason.
    const harnessNext = () => ({ kind: 'accept' });
    const out = await listener(EXEC, RESULT, harnessNext);
    assert.notEqual(out, undefined, 'an oversized read result is transformed in enforce mode');
    assert.ok(Array.isArray(out.content), 'the decision carries the rebuilt content, not a bare accept');
    // The harness's `tools/post-execute` waterfall takes a PostToolDecision. A
    // result-shaped answer (the whole result, `value` and `content` together) is
    // rejected with "accept decision cannot replace both value and content", which
    // made every pruning module error in enforce mode on a real turn: the model saw
    // an error string instead of the log. The gate previously read only `content`.
    assert.equal(out.kind, 'accept', 'the answer is an accept decision, as the harness requires');
    assert.equal('value' in out, false, 'it does not carry `value` beside `content`');
    const text = (out.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    assert.ok(text.length > 0, 'the rebuilt content still carries text');
    assert.notEqual(text, BIG_TEXT, 'the content is actually rebuilt');
    assert.ok(text.length < BIG_TEXT.length, 'the rebuilt content is shorter than the original');

    const rows = ledgerRows();
    assert.ok(rows.length > 0, 'the ledger file exists and holds at least one record');
    assert.ok(
      rows.some((row) => row.featureId === 'admit.output'),
      'a record names admit.output, so the judgment is attributable',
    );
    await registry.stop();
  }

  // 3. SHADOW: the same chain records the would-be decision and transforms nothing.
  {
    const before = ledgerRows().length;
    const { ctx, registry } = await harness({ mode: 'shadow', enabled: true });
    const listener = ctx.listeners.get(SEAMS.TOOLS_POST_EXECUTE);
    const harnessNext = () => ({ kind: 'accept' });
    const out = await listener(EXEC, RESULT, harnessNext);
    assert.deepEqual(out, { kind: 'accept' }, 'shadow abstains, so the harness keeps its own decision');

    const rows = ledgerRows();
    assert.ok(rows.length > before, 'shadow mode still writes a record');
    const fresh = rows.slice(before);
    assert.ok(
      fresh.some((row) => row.mode === 'shadow' || row.wouldBe !== undefined || row.decision !== undefined),
      'the shadow record says what would have happened',
    );
    await registry.stop();
  }

  console.log('GATE-T26-E2E-OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
