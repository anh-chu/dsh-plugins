/**
 * Gate G-T13-3: `nag.nogoal`.
 *
 * Both halves of the ticket, against the real artifact — the real module object,
 * the real registry and the real core (its event channel, ledger, shadow
 * resolver, notification transport and fetch):
 *
 *   A. The soft dependency. With the nag enabled and no publisher on the
 *      internal channel, `registry.start()` resolves, the module is started with
 *      no error, it is armed on the channel, and nothing is injected or sent.
 *      A2 repeats that over a core with no channel at all, with a start that
 *      throws as the positive control.
 *   B. The nag itself. One delegated event with no goal injects exactly one
 *      model-facing notice carrying `form: 'notice'` and this plugin's own source
 *      kind; a second identical event injects nothing.
 *
 * Plus the levers the behaviour fixes: `auto` resolves to the operator when the
 * goal tool `create_goal` is not registered (this host's condition) and to the
 * agent when it is; a goal that exists in any phase does not nag; shadow records
 * the would-be lever and acts on nothing; `nagTarget: 'off'` is silent; a payload
 * without an agent is recorded, never guessed at; `stop()` unsubscribes.
 *
 * Positive controls. Every absence assertion above is paired with the case where
 * the same detector fires: B is the control for A, C, E, G and I; D is the
 * control for C; the second session in B is the control for the per-session
 * latch; the enforced publish after the shadow run is the control for F.
 *
 * Run: node scripts/gate-t13-nag.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import nag from '../packages/plugin/src/modules/nag-nogoal.js';

/** The module's stable id, and therefore its config, ledger and shadow key. */
const FEATURE = 'nag.nogoal';
/** The plugin-internal channel the nag subscribes to. */
const CHANNEL = SEAMS.INTERNAL_QUESTION_EVALUATED;

/** Let queued microtasks (a send, a ledger line) settle before asserting. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A registry holding the real nag module, with a stub host context.
 *
 * `get` answers only the two services this module asks for: the goals service for
 * the autonomy read, and the tools service for the `auto` probe. `on` records the
 * seams the registry registers, so the gate can prove what the module does *not*
 * observe.
 */
function makeCtx({ goalOf, goalTool }) {
  const listeners = [];
  return {
    listeners,
    get(name) {
      if (name === 'goals') return { get: (agent) => goalOf(agent) };
      if (name === 'tools') {
        return {
          register: () => () => {},
          get: (toolName) => (goalTool && toolName === 'create_goal' ? { name: toolName } : undefined),
        };
      }
      return undefined;
    },
    inject: () => () => {},
    on(seam, fn) {
      listeners.push([seam, fn]);
      return () => {
        const index = listeners.findIndex(([registered, handler]) => registered === seam && handler === fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    logger: { warn() {}, info() {} },
    effect(fn) {
      fn();
      return () => {};
    },
  };
}

/**
 * One started composition: the real module under the real registry over a real
 * core. The notification transport is observed by wrapping `send` — the real
 * transport still runs underneath, through the stub fetch.
 *
 * @param {object} [options]
 * @param {string} [options.nagTarget] the module setting under test.
 * @param {boolean} [options.once] `nagOncePerSession`.
 * @param {(agent: object) => unknown} [options.goalOf] what the goals service returns.
 * @param {boolean} [options.goalTool] whether `create_goal` is registered.
 * @param {() => string} [options.modeOf] the live mode, so a scenario can flip it.
 * @param {string} [options.notifyUrl] the configured notification transport.
 */
async function scenario(options = {}) {
  const {
    nagTarget = 'agent',
    once = true,
    goalOf = () => undefined,
    goalTool = false,
    modeOf = () => 'enforce',
    notifyUrl = '',
  } = options;

  const injected = [];
  const sends = [];
  const outcomes = [];
  const fetchCalls = [];
  let pending = Promise.resolve();

  const agent = {
    id: 'agent-1',
    session: { id: 'session-1' },
    inject(message) {
      injected.push(message);
    },
  };

  const settings = {
    get(key) {
      if (key === `${FEATURE}.mode`) return modeOf();
      if (key === 'notify.url') return notifyUrl;
      return undefined;
    },
  };
  const core = createCore({
    settings,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return { status: 200, ok: true };
    },
  });

  const send = core.notifications.send;
  core.notifications.send = (text, meta) => {
    sends.push({ text, meta });
    pending = (async () => {
      const outcome = await send(text, meta);
      outcomes.push(outcome);
      return outcome;
    })();
    return pending;
  };

  const ctx = makeCtx({ goalOf, goalTool });
  const registry = createRegistry({
    modules: [nag],
    ctx,
    config: { [FEATURE]: { enabled: true, nagTarget, nagOncePerSession: once } },
    core,
  });
  await registry.start();

  return {
    registry,
    core,
    ctx,
    agent,
    injected,
    sends,
    outcomes,
    fetchCalls,
    publish: (payload) => core.events.publish(CHANNEL, payload),
    flush: async () => {
      await pending;
      await settle();
    },
    state: () => registry.state().find((entry) => entry.id === FEATURE),
    rows: () => core.ledger.read(FEATURE),
  };
}

/** One delegated question, as `answer.questions` publishes it. */
function delegated(agent, extra = {}) {
  return {
    callId: 'call-1',
    outcome: 'delegated',
    reason: 'no-goal',
    question: { id: 'q1', header: 'Which file?', question: 'Which file should I edit first?' },
    options: ['src/a.js', 'src/b.js'],
    at: Date.now(),
    agent,
    ...extra,
  };
}

// ── the descriptor the registry and docs/CONTRACT.md fix ─────────────────
assert.equal(nag.id, FEATURE);
assert.equal(CHANNEL, 'question/evaluated');
assert.equal(nag.seam, null, 'the nag consumes no harness seam: it hears the decision on the core channel');
assert.equal(nag.seamClass, 'broadcast', 'a module with no seam only observes');
assert.equal(typeof nag.handle, 'function', 'the registry requires a handler of every module');
assert.equal(nag.settings.nagTarget.default, 'auto');
assert.equal(nag.settings.nagOncePerSession.default, true);

// ── A. the soft dependency: nothing ever published ──────────────────────
{
  const s = await scenario({ nagTarget: 'agent' });
  assert.equal(s.state().started, true, 'the nag starts even when its publisher is absent');
  assert.equal(s.state().error, null);
  assert.equal(s.core.events.subscribers(CHANNEL), 1, 'it is armed on the internal channel, not dead');
  await s.flush();
  assert.equal(s.injected.length, 0, 'with no delegation event the nag injects nothing');
  assert.equal(s.sends.length, 0, 'and sends nothing');
  assert.deepEqual(s.rows(), [], 'and has no decision to record');

  // The exclusive seam answer.questions owns must not be observed here.
  const observes = (listeners) => listeners.some(([seam]) => seam === SEAMS.USER_QUESTIONS_REQUEST);
  assert.equal(observes([[SEAMS.USER_QUESTIONS_REQUEST, () => {}]]), true, 'positive control: the detector fires on a real observer');
  assert.equal(observes(s.ctx.listeners), false, 'the nag never observes user-questions/request');
}

// ── A2. no channel at all: the soft dependency must not fail startup ────
{
  // A core with neither an event channel nor a ledger: the worst case for a
  // subscriber. `start()` must return, and the module must be started and inert.
  const bare = {};
  const ctx = makeCtx({ goalOf: () => undefined, goalTool: false });
  const registry = createRegistry({
    modules: [nag],
    ctx,
    config: { [FEATURE]: { enabled: true, nagTarget: 'agent' } },
    core: bare,
  });
  await registry.start();
  const state = registry.state().find((entry) => entry.id === FEATURE);
  assert.equal(state.started, true, 'a host with no event channel still starts the nag');
  assert.equal(state.error, null);

  // Positive control: the same observation reports a start that really threw.
  const bad = {
    id: 'probe.bad',
    seam: SEAMS.TOOLS_RESULT,
    seamClass: 'broadcast',
    handle() {},
    start() {
      throw new Error('start exploded');
    },
  };
  const badRegistry = createRegistry({
    modules: [bad],
    ctx: makeCtx({ goalOf: () => undefined, goalTool: false }),
    config: { 'probe.bad': { enabled: true } },
    core: bare,
  });
  await badRegistry.start();
  const badState = badRegistry.state().find((entry) => entry.id === 'probe.bad');
  assert.equal(badState.started, false, 'positive control: a start that throws is reported as not started');
  assert.equal(badState.error, 'start exploded');
}

// ── B. one delegated event, no goal: exactly one labelled notice ────────
{
  const s = await scenario({ nagTarget: 'agent' });
  s.publish(delegated(s.agent));
  await s.flush();

  assert.equal(s.injected.length, 1, 'one delegated event with no goal injects exactly one notice');
  const message = s.injected[0];
  assert.equal(message.role, 'user');
  assert.equal(Array.isArray(message.content), true);
  assert.equal(message.content[0].type, 'text');
  assert.match(message.content[0].text, /no goal/i, 'the notice says why');
  assert.match(message.content[0].text, /create_goal/, 'and what would change it');
  assert.match(message.content[0].text, /Which file should I edit first\?/, 'and names the delegated question');
  assert.equal(message.source.kind, 'dsh-jev-layer', 'the plugin declares its own source kind');
  assert.equal(message.source.form, 'notice');
  assert.equal(typeof message.source.summary, 'string');
  assert.equal(message.source.summary.length > 0 && message.source.summary.length <= 120, true);
  assert.equal(typeof message.id, 'string', 'the inbox keys pending messages by identity');
  assert.equal(s.sends.length, 0, 'the agent path does not also notify the operator');

  const row = s.rows().at(-1);
  assert.equal(row.decision, 'nag');
  assert.equal(row.wouldBe, 'agent', 'the ledger records which lever was chosen');
  assert.equal(row.mode, 'enforce');

  // A second identical event: the once-per-session rule, recorded not dropped.
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 1, 'a second identical event injects nothing');
  assert.equal(s.rows().at(-1).decision, 'suppressed');
  assert.equal(s.rows().at(-1).wouldBe, 'once-per-session');

  // The latch is per session: another session is not silenced by this one.
  const other = { id: 'agent-2', session: { id: 'session-2' }, inject: (m) => s.injected.push(m) };
  s.publish(delegated(other));
  await s.flush();
  assert.equal(s.injected.length, 2, 'a different session still gets its one notice');
}

// ── C. auto with no goal tool: the operator path (this host's condition) ─
{
  const s = await scenario({ nagTarget: 'auto', goalTool: false, notifyUrl: 'https://notify.test/hook' });
  s.publish(delegated(s.agent));
  await s.flush();

  assert.equal(s.injected.length, 0, 'with no goal tool the agent-facing path is inert');
  assert.equal(s.sends.length, 1, 'auto falls back to the operator notification');
  assert.match(s.sends[0].text, /no goal/i);
  assert.equal(s.sends[0].meta.reason, 'no-goal');
  assert.equal(s.sends[0].meta.session, 'session-1');
  assert.equal(s.fetchCalls.length, 1, 'the real transport posted to the configured url');
  assert.equal(s.fetchCalls[0].url, 'https://notify.test/hook');
  assert.equal(JSON.parse(s.fetchCalls[0].init.body).text, s.sends[0].text);
  assert.equal(s.outcomes[0], 'sent');
  assert.equal(s.rows().at(-1).wouldBe, 'user');

  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.sends.length, 1, 'the operator is told once per session too');
}

// ── D. auto with the goal tool registered: the agent path, the control ───
{
  const s = await scenario({ nagTarget: 'auto', goalTool: true, notifyUrl: 'https://notify.test/hook' });
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 1, 'auto reaches the agent when it can act on the nag');
  assert.equal(s.sends.length, 0);
  assert.equal(s.rows().at(-1).wouldBe, 'agent');
}

// ── E. a goal exists, whatever its phase: a deliberate state, no nag ─────
{
  const s = await scenario({ nagTarget: 'agent', goalOf: () => ({ phase: 'paused', activation: 'disarmed' }) });
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 0, 'a paused, blocked or disarmed goal does not nag');
  assert.equal(s.sends.length, 0);
  assert.deepEqual(s.rows(), [], 'a deliberate goal state records nothing');
}

// ── F. shadow records the would-be lever and acts on nothing ────────────
{
  let mode = 'shadow';
  const s = await scenario({ nagTarget: 'agent', modeOf: () => mode });
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 0, 'shadow injects nothing');
  assert.equal(s.sends.length, 0, 'shadow sends nothing');
  const row = s.rows().at(-1);
  assert.equal(row.mode, 'shadow');
  assert.equal(row.decision, 'nag');
  assert.equal(row.wouldBe, 'agent', 'shadow records the lever it would have used');

  // Shadow does not close the latch: the enforced run in the same session still
  // delivers, which is also the positive control for this absence check.
  mode = 'enforce';
  s.publish(delegated(s.agent, { callId: 'call-2' }));
  await s.flush();
  assert.equal(s.injected.length, 1, 'an enforced run after a shadow run still delivers');
}

// ── G. nagTarget off ───────────────────────────────────────────────────
{
  const s = await scenario({ nagTarget: 'off' });
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 0);
  assert.equal(s.sends.length, 0);
  assert.equal(s.rows().at(-1).decision, 'off', 'the switch is visible in the ledger');
}

// ── H. the frozen payload carries no agent: record, never guess ─────────
{
  const s = await scenario({ nagTarget: 'agent' });
  s.publish(delegated(s.agent, { agent: undefined }));
  await s.flush();
  assert.equal(s.injected.length, 0, 'without an agent there is no recipient');
  assert.equal(s.sends.length, 0);
  assert.equal(s.rows().at(-1).decision, 'no-agent', 'the gap is recorded rather than guessed at');
}

// ── I. stop() releases the subscription ─────────────────────────────────
{
  const s = await scenario({ nagTarget: 'agent' });
  assert.equal(s.core.events.subscribers(CHANNEL), 1, 'positive control: subscribed before stop');
  await s.registry.stop();
  assert.equal(s.core.events.subscribers(CHANNEL), 0, 'stop() unsubscribes');
  assert.equal(s.state().started, false);
  s.publish(delegated(s.agent));
  await s.flush();
  assert.equal(s.injected.length, 0, 'after stop the nag is inert');
}

console.log('GATE-T13-NAG-OK');
