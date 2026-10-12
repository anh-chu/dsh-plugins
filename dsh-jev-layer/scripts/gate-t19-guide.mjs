/**
 * G-T19-2 (CID-20) — `guide.instructions` acceptance gate.
 *
 * The outcome under test: the module stays silent when the applicable rules or
 * instructions are present, and raises exactly one arbitrated notice when they
 * are absent.
 *
 * The absence case (1) is written first, so the silence cases that follow are
 * proven to be a detector holding back and not a module that can never fire.
 * Case 8 pairs an added instruction kind with the default kinds that do fire, so
 * the configurable detector has the same control.
 *
 * The module is exercised directly against a synthetic api (no network, no host,
 * no core), through the real registry's broadcast dispatch
 * (`packages/plugin/test/fixtures/harness.js`) so "the event comes back
 * unchanged" is proven on the path the host uses, and statically for the one
 * thing the ticket forbids: reading a file.
 *
 * Run from the repository root: `node scripts/gate-t19-guide.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../packages/plugin/src/registry.js';
import guide from '../packages/plugin/src/modules/guide-instructions.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'guide.instructions';
const MARKER = 'GATE-T19-GUIDE-OK';
const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'plugin',
  'src',
  'modules',
  'guide-instructions.js',
);

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

/** A message the user wrote. */
function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** A completed step: the first moment at which "absent" means anything. */
function assistantMessage(text = 'working on it') {
  return { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] };
}

/**
 * Instruction context, labelled the way its producer labels it. `form` is added
 * only when a case names one, so a case can exercise the source kind alone.
 */
function instructionMessage(text, { kind = 'agent-instructions', form } = {}) {
  const source = form === undefined ? { kind } : { kind, form };
  return { role: 'user', source, content: [{ type: 'text', text }] };
}

/** The arbiter's contract, as a recorder. */
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

/** The synthetic module api. */
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

/** The pre-step payload. */
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
  const out = guide.handle(event, api);
  assert.equal(out, undefined, 'a broadcast observer returns undefined, never a rewritten decision');
  assert.deepEqual(snapshot(event), before, 'the observed event comes back unchanged');
  return out;
}

// ── 1. positive control: no guidance in the session raises exactly one notice ─
{
  const session = makeSession('session-a', [userMessage('refactor the billing module'), assistantMessage()]);
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 2 }), api);

  assert.equal(arbiter.requests.length, 1, 'a session without instructions raises exactly one notice');
  const notice = arbiter.requests[0];
  assert.equal(notice.kind, 'advisory', 'the notice is advisory, not blocking');
  assert.equal(notice.tag, ID, 'the notice carries the module tag');
  assert.equal(notice.priority, 10, 'the notice carries the module priority');
  assert.match(notice.text, /no applicable rules or instructions/i, 'the notice says what is missing');
  assert.equal(notice.dedupeKey, `${ID}:session-a`, 'the dedupe key is stable per session');
  assert.equal(arbiter.delivered.length, 1, 'exactly one notice is delivered');
  const rows = ledger.filter((row) => row.decision === 'notice');
  assert.equal(rows.length, 1, 'the raised notice is recorded');
  assert.equal(rows[0].featureId, ID, 'the record is keyed by the module id');
  assert.equal(rows[0].mode, 'enforce', 'the record is in enforce mode');
  assert.equal(rows[0].callId, 'session-a', 'the record names the session it belongs to');
}

// ── 2. one notice per session, whatever the later steps say ─────────────────
{
  const session = makeSession('session-b', [userMessage('go'), assistantMessage()]);
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 2 }), api);
  observe(stepEvent(session, { step: 3 }), api);
  observe(stepEvent(session, { turn: 2, step: 1 }), api);

  assert.equal(arbiter.delivered.length, 1, 'the session gets one notice, not one per step');
  assert.equal(arbiter.requests.length, 1, 'the check runs once per session');
  assert.equal(ledger.filter((row) => row.decision === 'notice').length, 1, 'the notice is recorded once');
}

// ── 3. rules present: silent, against case 1's control ──────────────────────
{
  const session = makeSession('session-c', [
    instructionMessage('# Workspace rules\n\nRun the tests before reporting done.'),
    userMessage('refactor the billing module'),
    assistantMessage(),
  ]);
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 2 }), api);

  assert.equal(arbiter.requests.length, 0, 'instruction context in the history silences the module');
  assert.equal(arbiter.delivered.length, 0, 'nothing is delivered');
  const rows = ledger.filter((row) => row.decision === 'present');
  assert.equal(rows.length, 1, 'the presence is recorded once');
  assert.equal(rows[0].wouldBe, 'silent', 'the record says the module stayed silent');
}

// ── 4. a loaded skill is guidance too, and the safe failure is silence ──────
{
  const session = makeSession('session-d', [
    instructionMessage('Skill body: how to run the release.', { kind: 'skill-invocation', form: 'instructions' }),
    assistantMessage(),
  ]);
  const { api, arbiter } = makeApi();

  observe(stepEvent(session, { step: 2 }), api);

  assert.equal(arbiter.requests.length, 0, 'a message labelled form instructions counts as guidance');
}

// ── 5. before any step has completed, absence cannot be told from late ───────
{
  const session = makeSession('session-e', [userMessage('start here')]);
  const { api, ledger, arbiter } = makeApi();

  observe(stepEvent(session, { step: 1 }), api);

  assert.equal(arbiter.requests.length, 0, 'the first step of a turn never reports a gap');
  assert.equal(ledger.length, 0, 'nothing is judged and nothing is recorded');

  // The same session one step later is the control that the module then fires.
  session.push(assistantMessage());
  observe(stepEvent(session, { step: 2 }), api);
  assert.equal(arbiter.requests.length, 1, 'once a step has completed, the gap is reported');
}

// ── 6. instructions already claimed for this step count before they land ────
{
  const session = makeSession('session-f', [userMessage('go'), assistantMessage()]);
  const claimed = [instructionMessage('# Rules that arrived with this step')];
  const { api, arbiter } = makeApi();

  observe(stepEvent(session, { step: 2, messages: claimed }), api);

  assert.equal(arbiter.requests.length, 0, 'guidance claimed for the step is guidance present');
}

// ── 7. shadow records the would-be notice and raises nothing ────────────────
{
  const session = makeSession('session-g', [userMessage('go'), assistantMessage()]);
  const { api, ledger, arbiter } = makeApi({ shadow: true });

  observe(stepEvent(session, { step: 2 }), api);

  assert.equal(arbiter.requests.length, 0, 'shadow raises nothing');
  const row = ledger.find((entry) => entry.decision === 'notice');
  assert.ok(row, 'shadow records the decision it would have taken');
  assert.equal(row.mode, 'shadow', 'the record is marked shadow');
  assert.equal(row.wouldBe, 'notice', 'the shadow record keeps the would-be notice');
}

// ── 8. the instruction kinds are the deployment's to name ───────────────────
{
  const custom = () => makeSession('session-h', [
    instructionMessage('# House rules', { kind: 'house-rules' }),
    assistantMessage(),
  ]);

  const tuned = makeApi({ config: { instructionKinds: ['house-rules'] } });
  observe(stepEvent(custom(), { step: 2 }), tuned.api);
  assert.equal(tuned.arbiter.requests.length, 0, 'a configured kind silences the module');

  // Control for the same detector: with the defaults that message is unknown.
  const standard = makeApi();
  observe(stepEvent(custom(), { step: 2 }), standard.api);
  assert.equal(standard.arbiter.requests.length, 1, 'an unconfigured kind is not treated as guidance');
}

// ── 9. an arbiter suppression is recorded, and the session is still judged once
{
  const session = makeSession('session-i', [userMessage('go'), assistantMessage()]);
  const arbiter = makeArbiter({ answer: 'suppressed' });
  const { api, ledger } = makeApi({ arbiter });

  observe(stepEvent(session, { step: 2 }), api);
  observe(stepEvent(session, { step: 3 }), api);

  assert.equal(arbiter.requests.length, 1, 'the check runs once per session, suppressed or not');
  const rows = ledger.filter((row) => row.decision === 'suppressed');
  assert.equal(rows.length, 1, 'the suppression is recorded by the module');
  assert.equal(rows[0].wouldBe, 'notice', 'the record keeps what was held back');
}

// ── 10. the host's own path: the registry hands the decision back unchanged ──
{
  const session = makeSession('session-j', [userMessage('go'), assistantMessage()]);
  const event = stepEvent(session, { step: 2 });
  const before = snapshot(event);

  const arbiter = makeArbiter();
  const { core } = fakeCore({ notice: { request: (request) => arbiter.request(request), drain: () => [] } });
  const modules = [guide];
  const ctx = fakeCtx();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, [ID]), core });

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
    return { kind: 'enter', messages: [{ role: 'user' }] };
  });

  assert.equal(nextCalls, 1, 'the waterfall continuation runs exactly once');
  assert.deepEqual(
    decision,
    { kind: 'enter', messages: [{ role: 'user' }] },
    'the step decision passes through unchanged',
  );
  assert.deepEqual(snapshot(event), before, 'the payload is still what the harness handed over');
  assert.equal(arbiter.delivered.length, 1, 'the observer still raised its one notice through the container api');

  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'stop() releases the shared listener');
}

// ── 11. it reads no file. Positive control first: the detector can fire ─────
{
  const readsAFile = (source) => /node:fs|readFileSync|readFile\s*\(/.test(source);
  assert.ok(readsAFile("import { readFileSync } from 'node:fs';"), 'the detector fires on a module that reads files');
  assert.equal(
    readsAFile(readFileSync(MODULE_PATH, 'utf8')),
    false,
    'guide-instructions imports no filesystem module and reads no file',
  );
}

console.log(MARKER);
