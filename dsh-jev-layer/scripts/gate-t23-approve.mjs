/**
 * G-T23-1: an eligible escalation returns `ask`; a non-eligible call passes
 * through unchanged; a failing or unconfigured judge passes through rather than
 * allowing.
 *
 * The fixture is one native escalation request on this host's own vocabulary:
 * a `sandbox_permissions: 'danger-full-access'` plus a `justification`, from a
 * session whose sandbox mode is `workspace-write`, which is the one mode that
 * escalates to that target. The stub judge answers with a typed `choice`.
 *
 * Positive controls, so every absence check can fire:
 *   - The eligible case is shown to produce `{ kind: 'ask' }` with one judge
 *     call, so "a non-eligible call does not ask" and "no judge was paid for"
 *     cannot be satisfied by a module that never does anything.
 *   - Every pass-through result is compared by identity with the continuation's
 *     own return value, so a module that built its own `{ kind: 'allow' }` could
 *     not pass the "never allows" check.
 *
 * Run from the repo root: node scripts/gate-t23-approve.mjs
 */
import assert from 'node:assert/strict';
import approve from '../packages/plugin/src/modules/approve-workspace.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const ID = 'approve.workspace';
const TARGETS = ['write', 'edit', 'bash', 'pwsh', 'run_code'];
const QUESTION_ID = 'authorization';

const AGENT = { id: 'agent-1', session: { id: 'session-1' } };
const SIGNAL = new AbortController().signal;

/** One native escalation request, in the shape the tool schemas require. */
function escalationExec(overrides = {}) {
  return {
    name: overrides.name ?? 'bash',
    callId: overrides.callId ?? 'call-t23-1',
    agent: 'agent' in overrides ? overrides.agent : AGENT,
    signal: overrides.signal ?? SIGNAL,
    arguments: {
      command: 'python3 tools/publish.py --out /tmp/site',
      description: 'Publish the built site',
      sandbox_permissions: 'danger-full-access',
      justification: 'The publish step writes outside the workspace root.',
      ...(overrides.arguments ?? {}),
    },
  };
}

/**
 * A synthetic module context matching docs/CONTRACT.md.
 *
 * `options.answer` is what the stub judge returns for the one question;
 * `options.ask` overrides the stub entirely; `options.noSandboxPolicy` removes
 * the host service, which is the real state of the frozen module api today.
 */
function makeApi(options = {}) {
  const ledger = [];
  const calls = { ask: 0, acquired: 0, options: null };
  const config = { enabled: true, ...(options.config ?? {}) };
  const api = {
    id: ID,
    config: { get: (key) => config[key] },
    judge: {
      configured: options.configured ?? true,
      ask: async (state, questions, opts) => {
        calls.ask += 1;
        calls.state = state;
        calls.questions = questions;
        calls.options = opts;
        if (typeof options.ask === 'function') return options.ask(state, questions, opts);
        if (options.throws) throw new Error('judge transport failed');
        if ('answer' in options) return { [QUESTION_ID]: options.answer };
        return null;
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
  if (options.noSandboxPolicy !== true) {
    api.sandboxPolicy = {
      resolve: ({ session } = {}) => ({
        mode: options.mode ?? 'workspace-write',
        workspaceRoot: '/home/dev/repo',
        sessionId: session?.id,
      }),
    };
  }
  return { api, ledger, calls };
}

/** A readable, confident answer at the given choice. */
function answer(choice, top) {
  return {
    type: 'choice',
    choice,
    probabilities: Object.fromEntries(
      [['approve', 0], ['unauthorized', 0], ['unknown', 0]].map(([label]) => [
        label,
        label === choice ? top : (1 - top) / 2,
      ]),
    ),
  };
}

/**
 * Run one call and return everything the assertions need. `downstream` defaults
 * to the harness's own allow decision, which is what `next()` ends in when
 * nothing else objects.
 */
async function run(exec, options = {}, downstream = { kind: 'allow' }) {
  const { api, ledger, calls } = makeApi(options);
  let nextCalls = 0;
  const out = await approve.handle(exec, api, async () => {
    nextCalls += 1;
    return downstream;
  });
  return { out, downstream, ledger, calls, nextCalls };
}

/**
 * Every result the module ever produced, paired with the continuation value it
 * was handed, for the final "never builds its own allow" sweep.
 */
const results = [];

/** A pass-through: the continuation was taken once and its value came back. */
function assertPassThrough(result, label) {
  results.push({ out: result.out, downstream: result.downstream });
  assert.equal(result.nextCalls, 1, `${label}: the continuation was taken once`);
  assert.equal(result.out, result.downstream, `${label}: the continuation's own value came back`);
  assert.notEqual(result.out?.kind, 'ask', `${label}: the module did not ask`);
  return result;
}

/** An ask: the module's own decision, and never an allow. */
function assertAsk(result, label) {
  results.push({ out: result.out, downstream: result.downstream });
  assert.ok(result.out && typeof result.out === 'object', `${label}: a decision came back`);
  assert.equal(result.out.kind, 'ask', `${label}: the human is consulted`);
  assert.notEqual(result.out.kind, 'allow', `${label}: the module did not allow`);
  assert.equal(result.nextCalls, 1, `${label}: the harness's own decision was still taken`);
  assert.equal(typeof result.out.displayReason?.en, 'string', `${label}: a display reason is present`);
  return result;
}

// ── the descriptor the registry reads ─────────────────────────────────────
assert.equal(approve.id, 'approve.workspace');
assert.equal(approve.seam, SEAMS.TOOLS_PRE_EXECUTE);
assert.equal(approve.seamClass, 'exclusive');
assert.deepEqual(approve.targets, TARGETS);
assert.equal(approve.settings.minProbability.default, 0.9);
assert.equal(approve.settings.deadlineMs.default, 2500);
assert.equal(typeof approve.handle, 'function');
assert.equal(typeof approve.start, 'undefined', 'the module keeps no per-agent state');
assert.equal(typeof approve.stop, 'undefined');

// ── positive control: an eligible escalation asks, and pays for one judge ──
{
  const exec = escalationExec();
  const before = structuredClone(exec.arguments);
  const result = await run(exec, { answer: answer('approve', 0.95) });
  assertAsk(result, 'eligible approve');
  assert.equal(result.calls.ask, 1, 'exactly one judge request went out');
  assert.equal(result.calls.acquired, 1, 'the budget was asked for one unit');
  assert.equal(result.calls.options.featureId, ID, 'the judge call carries this feature id');
  assert.equal(result.calls.options.failOpen, 'pass-through', 'the fail-open is this call site\'s');
  assert.ok(result.calls.state?.request?.tool === 'bash', 'the judge sees the tool');
  assert.equal(
    result.calls.state.request.arguments.sandbox_permissions,
    'danger-full-access',
    'the judge sees the requested mode',
  );
  assert.ok(result.calls.questions?.[QUESTION_ID], 'the one authorization question was asked');
  assert.deepEqual(exec.arguments, before, 'the input call was not mutated');

  assert.equal(result.ledger.length, 1, 'one decision was recorded');
  assert.equal(result.ledger[0].featureId, ID);
  assert.equal(result.ledger[0].callId, 'call-t23-1');
  assert.equal(result.ledger[0].decision, 'ask:approve');
  assert.equal(result.ledger[0].wouldBe, 'ask');
  assert.equal(result.ledger[0].mode, 'enforce');
  assert.equal(result.ledger[0].threshold, 0.9);
  assert.equal(result.ledger[0].probabilities.approve, 0.95);
}

// ── every other readable verdict also asks, including a weak approve ───────
for (const [label, verdict, expected] of [
  ['unauthorized', answer('unauthorized', 0.97), 'ask:unauthorized'],
  ['unknown', answer('unknown', 0.93), 'ask:unknown'],
  ['low-confidence approve', answer('approve', 0.6), 'ask:approve-low'],
]) {
  const result = await run(escalationExec({ callId: `call-t23-${label}` }), { answer: verdict });
  assertAsk(result, label);
  assert.equal(result.ledger[0].decision, expected, `${label}: the verdict is recorded`);
}

// ── non-eligible calls: pass through, and no judge is paid for ─────────────
{
  const cases = [
    ['no escalation pair', escalationExec({ arguments: { sandbox_permissions: undefined, justification: undefined } })],
    ['the same mode', escalationExec({ arguments: { sandbox_permissions: 'workspace-write' } })],
    ['read-only session', escalationExec(), { mode: 'read-only' }],
    ['already unconfined session', escalationExec(), { mode: 'danger-full-access' }],
    ['a tool with no escalation arguments', escalationExec({ name: 'read' })],
    ['no agent', escalationExec({ agent: null })],
    ['no host policy service', escalationExec(), { noSandboxPolicy: true }],
    ['empty justification', escalationExec({ arguments: { justification: '   ' } })],
    ['malformed bash request', escalationExec({ arguments: { description: undefined } })],
    ['malformed write request', escalationExec({ name: 'write', arguments: { command: undefined, file_path: undefined } })],
  ];
  for (const [label, exec, options] of cases) {
    const result = await run(exec, { ...(options ?? {}), answer: answer('approve', 0.99) });
    assertPassThrough(result, label);
    assert.equal(result.calls.ask, 0, `${label}: no judge request was paid for`);
    assert.equal(result.ledger.length, 0, `${label}: nothing was recorded, because nothing was judged`);
  }
}

// ── a judge that cannot answer passes through rather than allowing ─────────
{
  const cases = [
    ['unconfigured judge', { configured: false, answer: answer('approve', 0.99) }],
    ['judge throws', { throws: true }],
    ['judge returns null', { answer: null }],
    ['judge returns nothing', {}],
    ['unreadable answer', { answer: { type: 'choice', choice: 'maybe', probabilities: {} } }],
    ['budget refused', { acquire: false, answer: answer('approve', 0.99) }],
    ['budget throws', { budgetThrows: true, answer: answer('approve', 0.99) }],
    ['judge past the deadline', { config: { deadlineMs: 1 }, ask: () => new Promise(() => {}) }],
  ];
  for (const [label, options] of cases) {
    const result = await run(escalationExec({ callId: `call-t23-${label}` }), options);
    assertPassThrough(result, label);
    assert.equal(result.ledger[0]?.decision?.startsWith('pass:'), true, `${label}: the pass is recorded`);
    assert.equal(result.ledger[0].wouldBe, 'ask', `${label}: what was forgone is recorded`);
  }
  const refused = (await run(escalationExec(), { configured: false })).ledger[0];
  assert.equal(refused.mode, 'enforce', 'an enforce-mode pass is recorded as enforce');
}

// ── a decision downstream already took is never weakened ───────────────────
for (const downstream of [
  { kind: 'deny', reason: 'sandbox policy' },
  { kind: 'cancel' },
  { kind: 'ask', reason: 'another gate asked first' },
]) {
  const result = await run(escalationExec(), { answer: answer('approve', 0.99) }, downstream);
  results.push({ out: result.out, downstream: result.downstream });
  assert.equal(result.nextCalls, 1, `${downstream.kind}: the continuation was taken once`);
  assert.equal(result.out, downstream, `${downstream.kind}: the existing decision stands`);
  assert.notEqual(result.out.kind, 'allow', `${downstream.kind}: nothing was allowed`);
  assert.equal(result.ledger[0].decision, `pass:downstream-${downstream.kind}`);
}

// ── shadow records the would-be ask and acts on nothing ───────────────────
{
  const result = await run(escalationExec({ callId: 'call-t23-shadow' }), {
    shadow: true,
    answer: answer('approve', 0.99),
  });
  assertPassThrough(result, 'shadow');
  assert.equal(result.calls.ask, 1, 'shadow still measures');
  assert.equal(result.ledger[0].decision, 'pass:shadow');
  assert.equal(result.ledger[0].wouldBe, 'ask');
  assert.equal(result.ledger[0].mode, 'shadow');
}

// ── the module never builds an allow on any path it exercises ──────────────
for (const [index, { out, downstream }] of results.entries()) {
  const asked = out?.kind === 'ask';
  const untouched = out === downstream;
  assert.ok(
    asked || untouched,
    `result #${index} is either this module's ask or the harness's own value, never a new decision`,
  );
}
assert.ok(results.some(({ out }) => out?.kind === 'ask'), 'the sweep really covered an ask');
assert.ok(
  results.some(({ out, downstream }) => out === downstream && out?.kind === 'allow'),
  'the sweep really covered a pass-through of the harness\'s own allow',
);

console.log('GATE-T23-APPROVE-OK');
