/**
 * G-T19-1 (CID-20) — `remind.drift` acceptance gate.
 *
 * The outcome under test: a repeated unproductive pattern raises exactly one
 * arbitrated notice per session for that pattern, a healthy run raises none, and
 * the suppression of the repeat is recorded.
 *
 * Order matters: every absence assertion below is preceded by the case that
 * proves the detector fires. Case 1 is the positive control for the notice; case
 * 4's healthy run is paired with case 1, not asserted on its own.
 *
 * The module is exercised twice over: directly against a synthetic api (no
 * network, no host, no core) so the notice count and the dedupe key are read
 * from the request itself, and through the real registry's broadcast dispatch
 * (`packages/plugin/test/fixtures/harness.js`) so "the event comes back
 * unchanged" is proven on the path the host actually uses.
 *
 * Run from the repository root: `node scripts/gate-t19-drift.mjs`
 */
import assert from 'node:assert/strict';

import { createRegistry } from '../packages/plugin/src/registry.js';
import drift from '../packages/plugin/src/modules/remind-drift.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'remind.drift';
const MARKER = 'GATE-T19-DRIFT-OK';

// ── fixtures ─────────────────────────────────────────────────────────────

/** A session whose model-visible history the case controls. */
function makeSession(id, messages = []) {
  const state = { id, messages };
  return {
    id,
    deriveMessages: () => state.messages,
    push: (...added) => state.messages.push(...added),
  };
}

/** One assistant message carrying the tool calls the model requested. */
function calls(...specs) {
  return {
    role: 'assistant',
    content: specs.map((spec) => ({
      type: 'tool-call',
      id: spec.id,
      name: spec.name,
      arguments: typeof spec.arguments === 'string' ? spec.arguments : JSON.stringify(spec.arguments ?? {}),
    })),
  };
}

/** One tool-role message answering a call. */
function result(id, { isError = false } = {}) {
  return {
    role: 'tool',
    toolCallId: id,
    isError,
    content: [{ type: 'text', text: isError ? 'exit 1' : 'ok' }],
  };
}

/** `n` identical calls plus their successful answers. */
function repeatRun(name, args, n, { isError = false, prefix = '' } = {}) {
  const messages = [];
  for (let index = 0; index < n; index += 1) {
    const id = `${prefix}${name}-${index}`;
    messages.push(calls({ id, name, arguments: args }), result(id, { isError }));
  }
  return messages;
}

/**
 * The arbiter's contract, as a recorder: one notice per dedupe key, every
 * duplicate or refused request recorded rather than dropped.
 */
function makeArbiter({ answer = 'accepted' } = {}) {
  const requests = [];
  const delivered = [];
  const suppressed = [];
  const seen = new Set();
  return {
    requests,
    delivered,
    suppressed,
    request(request) {
      requests.push(request);
      if (answer === 'suppressed') {
        suppressed.push({ ...request, reason: 'one-per-turn' });
        return 'suppressed';
      }
      const key = request?.dedupeKey ?? request?.text;
      if (seen.has(key)) {
        suppressed.push({ ...request, reason: 'duplicate' });
        return 'suppressed';
      }
      seen.add(key);
      delivered.push(request);
      return 'accepted';
    },
  };
}

/** The synthetic module api. Config returns nothing unless a case overrides it. */
function makeApi({ shadow = false, arbiter = makeArbiter(), config = {} } = {}) {
  const ledger = [];
  return {
    ledger,
    arbiter,
    api: {
      id: ID,
      config: { get: (key) => config[key] },
      ledger: { append: (row) => ledger.push(row) },
      shadow: { isShadow: () => shadow },
      notice: { request: (request) => arbiter.request(request) },
    },
  };
}

/** The pre-step payload. `turn`/`step` are what the harness passes. */
function stepEvent(session, { turn = 1, step = 1, messages = [] } = {}) {
  return { agent: { id: 'agent-1', session }, messages, turn, step, signal: undefined };
}

/** Snapshot of the fields a broadcast observer must leave alone. */
function snapshot(event) {
  return {
    turn: event.turn,
    step: event.step,
    messages: JSON.parse(JSON.stringify(event.messages)),
    agent: event.agent,
    session: event.agent.session,
  };
}

/** Call the module and assert it changed nothing about the event it observed. */
function observe(event, api) {
  const before = snapshot(event);
  const out = drift.handle(event, api);
  assert.equal(out, undefined, 'a broadcast observer returns undefined, never a rewritten decision');
  assert.deepEqual(snapshot(event), before, 'the observed event comes back unchanged');
  return out;
}

// ── 1. positive control: the same call three times raises exactly one notice ──
{
  const session = makeSession('session-a', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const event = stepEvent(session, { step: 4 });
  const { api, ledger, arbiter } = makeApi();

  observe(event, api);

  assert.equal(arbiter.requests.length, 1, 'a repeated call raises exactly one notice request');
  const notice = arbiter.requests[0];
  assert.equal(notice.kind, 'advisory', 'the notice is advisory, not blocking');
  assert.equal(notice.tag, ID, 'the notice carries the module tag');
  assert.equal(notice.priority, 10, 'the notice carries the module priority');
  assert.match(notice.text, /read/, 'the notice names the repeated tool');
  assert.match(notice.text, /3/, 'the notice names the run length');
  assert.ok(
    typeof notice.dedupeKey === 'string' && notice.dedupeKey.startsWith(`${ID}:session-a:repeat:read:`),
    'the dedupe key identifies the session and the pattern, so the arbiter can suppress a repeat',
  );
  assert.equal(arbiter.delivered.length, 1, 'exactly one notice is delivered');
  const rows = ledger.filter((row) => row.decision === 'notice');
  assert.equal(rows.length, 1, 'the raised notice is recorded');
  assert.equal(rows[0].featureId, ID, 'the record is keyed by the module id');
  assert.equal(rows[0].mode, 'enforce', 'the record is in enforce mode');
  assert.equal(rows[0].callId, 'session-a', 'the record names the session it belongs to');
}

// ── 2. the same pattern on later steps: one notice for the session ───────────
{
  const session = makeSession('session-b', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 4 }), api);
  session.push(...repeatRun('read', { file_path: '/work/a.js' }, 2, { prefix: 'more-' }));
  observe(stepEvent(session, { step: 5 }), api);
  observe(stepEvent(session, { turn: 2, step: 1 }), api);

  assert.equal(arbiter.delivered.length, 1, 'the session gets one notice for the pattern, not one per step');
  assert.equal(arbiter.requests.length, 1, 'a delivered pattern is not handed to the arbiter again');
  const silences = ledger.filter((row) => row.decision === 'suppressed');
  assert.equal(silences.length, 2, 'each later occurrence of the pattern records a suppression');
  assert.ok(
    silences.every((row) => row.wouldBe.startsWith('repeat:read:')),
    'the suppression names the pattern it held back',
  );
}

// ── 3. below the threshold nothing fires: case 1 is the control that three do ─
{
  const session = makeSession('session-c', repeatRun('read', { file_path: '/work/a.js' }, 2));
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 3 }), api);

  assert.equal(arbiter.requests.length, 0, 'twice is not the threshold of three');
  assert.equal(ledger.length, 0, 'no judgment is recorded when there is no drift');
}

// ── 4. a healthy run, against case 1's control ──────────────────────────────
{
  const session = makeSession('session-d', [
    ...repeatRun('read', { file_path: '/work/a.js' }, 1, { prefix: 'h1-' }),
    ...repeatRun('grep', { pattern: 'needle' }, 1, { prefix: 'h2-' }),
    ...repeatRun('read', { file_path: '/work/b.js' }, 1, { prefix: 'h3-' }),
    ...repeatRun('glob', { pattern: '**/*.md' }, 1, { prefix: 'h4-' }),
  ]);
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 5 }), api);

  assert.equal(arbiter.requests.length, 0, 'varied work raises no notice');
  assert.equal(ledger.length, 0, 'a healthy run records nothing');
}

// ── 5. the same tool failing, with different arguments, is a failure loop ────
{
  const session = makeSession('session-e', [
    ...repeatRun('bash', { command: 'npm test -- a' }, 1, { isError: true, prefix: 'f1-' }),
    ...repeatRun('bash', { command: 'npm test -- b' }, 1, { isError: true, prefix: 'f2-' }),
    ...repeatRun('bash', { command: 'npm test -- c' }, 1, { isError: true, prefix: 'f3-' }),
  ]);
  const { api, arbiter } = makeApi();

  observe(stepEvent(session, { step: 4 }), api);

  assert.equal(arbiter.requests.length, 1, 'three consecutive failures raise one notice');
  assert.match(arbiter.requests[0].text, /bash/, 'the failure loop names the tool');
  assert.match(arbiter.requests[0].dedupeKey, /failure:bash$/, 'the failure pattern has its own key');
}

// ── 6. a call that failed once and then succeeded is not a failure loop ──────
{
  const session = makeSession('session-f', [
    ...repeatRun('bash', { command: 'npm test -- a' }, 1, { isError: true, prefix: 'g1-' }),
    ...repeatRun('bash', { command: 'npm test -- b' }, 2, { prefix: 'g2-' }),
  ]);
  const { api, arbiter } = makeApi();

  observe(stepEvent(session, { step: 4 }), api);

  assert.equal(arbiter.requests.length, 0, 'one failure then successes is not a loop');
}

// ── 7. an arbiter suppression is recorded and does not latch the pattern ─────
{
  const session = makeSession('session-g', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const arbiter = makeArbiter({ answer: 'suppressed' });
  const { api, ledger } = makeApi({ arbiter });

  observe(stepEvent(session, { step: 4 }), api);
  observe(stepEvent(session, { step: 5 }), api);

  assert.equal(arbiter.requests.length, 2, 'a suppressed request may be made again on a later step');
  const rows = ledger.filter((row) => row.decision === 'suppressed');
  assert.equal(rows.length, 2, 'each suppressed request is recorded by the module');
  assert.equal(rows[0].wouldBe.startsWith('repeat:read:'), true, 'the record names the pattern');
}

// ── 8. shadow records the would-be notice and raises nothing ────────────────
{
  const session = makeSession('session-h', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const { api, ledger, arbiter } = makeApi({ shadow: true });

  observe(stepEvent(session, { step: 4 }), api);

  assert.equal(arbiter.requests.length, 0, 'shadow raises nothing');
  const row = ledger.find((entry) => entry.decision === 'notice');
  assert.ok(row, 'shadow records the decision it would have taken');
  assert.equal(row.mode, 'shadow', 'the record is marked shadow');
  assert.ok(row.wouldBe.startsWith('repeat:read:'), 'the shadow record keeps the would-be pattern');
}

// ── 9. settings: a raised threshold is honoured, the default is not ─────────
{
  const session = makeSession('session-i', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const { api, arbiter } = makeApi({ config: { repeatThreshold: 4 } });

  observe(stepEvent(session, { step: 4 }), api);

  assert.equal(arbiter.requests.length, 0, 'three repeats are below a threshold of four');
}

// ── 10. equivalent arguments are one call however they were spelled ─────────
{
  const session = makeSession('session-j', [
    ...repeatRun('read', { file_path: '/work/a.js', limit: 10 }, 1, { prefix: 'k1-' }),
    ...repeatRun('read', { limit: 10, file_path: '/work/a.js' }, 1, { prefix: 'k2-' }),
    ...repeatRun('read', { file_path: '/work/a.js', limit: 10 }, 1, { prefix: 'k3-' }),
  ]);
  const { api, arbiter } = makeApi();

  observe(stepEvent(session, { step: 4 }), api);

  assert.equal(arbiter.requests.length, 1, 'a reordered key is the same call, not a different one');

  // The control for the same detector: one genuinely different value is not.
  const other = makeSession('session-j2', [
    ...repeatRun('read', { file_path: '/work/a.js', limit: 10 }, 1, { prefix: 'm1-' }),
    ...repeatRun('read', { file_path: '/work/a.js', limit: 11 }, 1, { prefix: 'm2-' }),
    ...repeatRun('read', { file_path: '/work/a.js', limit: 10 }, 1, { prefix: 'm3-' }),
  ]);
  const control = makeApi();
  observe(stepEvent(other, { step: 4 }), control.api);

  assert.equal(control.arbiter.requests.length, 0, 'a different argument value breaks the run');
}

// ── 11. the host's own path: the registry hands the decision back unchanged ──
{
  const session = makeSession('session-k', repeatRun('read', { file_path: '/work/a.js' }, 3));
  const event = stepEvent(session, { step: 4 });
  const before = snapshot(event);

  const arbiter = makeArbiter();
  const { core } = fakeCore({ notice: { request: (request) => arbiter.request(request), drain: () => [] } });
  const modules = [drift];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, [ID]),
    core,
  });

  const states = await registry.start();
  assert.deepEqual(
    states.map((state) => ({ id: state.id, seam: state.seam, seamClass: state.seamClass })),
    [{ id: ID, seam: SEAMS.AGENT_PRE_STEP, seamClass: 'broadcast' }],
    'the descriptor declares the frozen broadcast seam',
  );
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'the registry registers one listener for the seam');

  let nextCalls = 0;
  const decision = await ctx.fire(SEAMS.AGENT_PRE_STEP, event, () => {
    nextCalls += 1;
    return { kind: 'enter', messages: [] };
  });

  assert.equal(nextCalls, 1, 'the waterfall continuation runs exactly once');
  assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the step decision passes through unchanged');
  assert.deepEqual(snapshot(event), before, 'the payload is still what the harness handed over');
  assert.equal(arbiter.delivered.length, 1, 'the observer still raised its one notice through the container api');

  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'stop() releases the shared listener');
}

console.log(MARKER);
