/**
 * G-T14-1 (CID-12) — `notify.decline` acceptance gate.
 *
 * The outcome under test: when a question is delegated inside an armed goal, one
 * message is raised through the core transport; with no transport configured
 * nothing is sent at all; a second decline inside the interval is suppressed and
 * recorded; and a failing transport still leaves the outcome a delegation.
 *
 * Everything here is real: the real core (`createCore`, with a stub fetch and an
 * injected clock), the real registry, and the real module file. The publisher of
 * the internal event is a probe module owned by this gate, not a T13 file, so
 * this gate stays runnable while T13 is still in flight. The probe enters on the
 * harness seam the way `answer.questions` will, publishes
 * `question/evaluated` synchronously, and returns the delegation — exactly the
 * sequence this module must survive.
 *
 * Positive control: case 1 proves the fetch counter can fire, and case 2 proves
 * the same counter stays at zero with the transport off. A detector that can
 * only report "nothing happened" proves nothing.
 *
 * Run from the repository root: `node scripts/gate-t14-notify.mjs`
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import notify, { idle, stats } from '../packages/plugin/src/modules/notify-decline.js';
import { fakeCtx, makeConfig, volatileRef } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'notify.decline';
const NOTIFY_URL = 'https://notifier.test/bark';
const DELEGATED = 'DELEGATED-TO-HUMAN';
const MARKER = 'GATE-T14-NOTIFY-OK';

/** The goal view an armed loop reports. */
const ARMED = { phase: 'active', activation: 'armed' };

/**
 * The publisher of the internal event, standing in for `answer.questions`.
 *
 * It enters on `user-questions/request` (the seam T13 owns), publishes the
 * decision moment on the core channel, and returns the delegation string.
 */
const PROBE = {
  id: 'gate.probe.delegate',
  seam: SEAMS.USER_QUESTIONS_REQUEST,
  handle(event, api) {
    api.events.publish(SEAMS.INTERNAL_QUESTION_EVALUATED, event?.payload);
    return DELEGATED;
  },
};

/** A payload shaped exactly like the frozen one in docs/CONTRACT.md. */
function payload(overrides = {}) {
  const agent = overrides.agent ?? { id: 'agent-1', session: { id: 'session-abc' } };
  return {
    callId: 'call-1',
    outcome: 'delegated:margin',
    reason: 'margin',
    question: 'Which file should I touch?',
    options: [{ label: 'the handler' }, { label: 'the test' }],
    at: 1_000,
    agent,
    ...overrides,
  };
}

/**
 * One isolated fixture: a real core with a stub fetch, the real core channel,
 * the real registry running the module, and the probe that publishes.
 */
function fixture({ settings = {}, now = () => 0, fetchImpl, config = {} } = {}) {
  const calls = [];
  const fetch = fetchImpl ?? (async (url, init) => {
    calls.push({ url, init });
    return { status: 200 };
  });
  const core = createCore({
    settings: { get: (key) => settings[key] },
    fetchImpl: fetch,
    now,
  });
  const ctx = fakeCtx({ services: { goals: { get: () => ARMED } } });
  const modules = [notify, PROBE];
  const live = makeConfig(modules, [ID, PROBE.id]);
  for (const [key, value] of Object.entries(config)) {
    live[ID][key] = volatileRef(value);
  }
  const registry = createRegistry({ modules, ctx, config: live, core });

  return {
    core,
    ctx,
    calls,
    /** Start the registry and hand back the configured module api. */
    async start() {
      await registry.start();
      return core;
    },
    /** Deliver one event through the probe, as the harness would. */
    fire(event) {
      return ctx.fire(SEAMS.USER_QUESTIONS_REQUEST, { payload: event }, () => DELEGATED);
    },
    /** Deliver one event and wait for the send it may start. */
    async decline(event) {
      const result = this.fire(event);
      await idle();
      return result;
    },
    stop: () => registry.stop(),
  };
}

/** The decision field of every ledger row this module wrote. */
function decisions(fx) {
  return fx.core.ledger.read(ID).map((row) => row.decision);
}

// ── 1. Positive control: an armed-goal decline sends exactly one notification.

{
  const fx = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
  });
  await fx.start();
  const result = await fx.decline(payload());

  assert.equal(result, DELEGATED, 'the decline is still a delegation');
  assert.equal(fx.calls.length, 1, 'exactly one HTTP request is made');
  assert.equal(fx.calls[0].url, NOTIFY_URL, 'the notification goes to the configured URL');
  const body = JSON.parse(fx.calls[0].init.body);
  assert.equal(body.question, 'Which file should I touch?', 'the payload carries the question text');
  assert.equal(body.options, 'the handler | the test', 'the payload carries the option labels');
  assert.equal(body.reason, 'margin', 'the payload carries the failing gate');
  assert.equal(body.session, 'session-abc', 'the payload carries the session id');
  assert.match(body.text, /Which file should I touch\?/, 'the message text names the question');
  assert.deepEqual(decisions(fx), ['notify-sent'], 'the send is recorded in the ledger');
  await fx.stop();
}

// ── 2. With no transport configured nothing is sent, and neither is an
//      autonomy-gate reason reported.

{
  const fx = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    // transport keeps its declared default: 'off'.
  });
  await fx.start();
  await fx.decline(payload());
  assert.equal(fx.calls.length, 0, 'transport off: no HTTP request at all');
  assert.deepEqual(decisions(fx), [], 'transport off is not a suppression: nothing is recorded as one');
  await fx.stop();

  const armed = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
  });
  await armed.start();
  await armed.decline(payload({ outcome: 'delegated:no-goal', reason: 'no-goal' }));
  await armed.decline(payload({ outcome: 'delegated:disarmed', reason: 'disarmed' }));
  assert.equal(armed.calls.length, 0, 'an autonomy-gate reason is never notified: a human is expected');
  await armed.stop();
}

// ── 3. A second decline inside the interval is suppressed and counted.

{
  let clock = 0;
  const fx = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
    now: () => clock,
  });
  await fx.start();
  await fx.decline(payload({ callId: 'call-1' }));
  clock = 1_000;
  await fx.decline(payload({ callId: 'call-2' }));

  assert.equal(fx.calls.length, 1, 'the second message inside the interval is not sent');
  assert.equal(fx.core.notifications.stats().suppressed, 1, 'the core records the suppression');
  assert.deepEqual(decisions(fx), ['notify-sent', 'notify-suppressed'], 'both outcomes are recorded');
  assert.deepEqual(stats().recent.map((entry) => entry.outcome), ['sent', 'suppressed'], 'the module counts both');

  clock = 61_000;
  await fx.decline(payload({ callId: 'call-3' }));
  assert.equal(fx.calls.length, 2, 'a later decline is sent again');
  await fx.stop();
}

// ── 4. A failing transport still leaves the outcome a delegation.

{
  const boom = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  await boom.start();
  const thrown = await boom.decline(payload());
  assert.equal(thrown, DELEGATED, 'a transport that throws does not change the delegation');
  assert.deepEqual(decisions(boom), ['notify-failed'], 'the failure is recorded');
  await boom.stop();

  const denied = fixture({
    settings: { mode: 'enforce', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
    fetchImpl: async () => ({ status: 500 }),
  });
  await denied.start();
  const rejected = await denied.decline(payload());
  assert.equal(rejected, DELEGATED, 'a non-2xx transport does not change the delegation');
  assert.deepEqual(decisions(denied), ['notify-failed'], 'the rejection is recorded');
  await denied.stop();
}

// ── 5. The command transport substitutes the message, and escapes it.

{
  const dir = mkdtempSync(join(tmpdir(), 'gate-t14-'));
  const out = join(dir, 'message.txt');
  const pwn = join(dir, 'pwned');
  try {
    const fx = fixture({
      settings: { mode: 'enforce' },
      config: {
        transport: 'command',
        commandTemplate: `cat > ${out} <<'EOF'\n{title}\n{body}\nreason={reason} session={session}\nEOF`,
      },
    });
    await fx.start();
    // The question carries a quote and a command substitution: if the value is
    // not escaped, the substitution runs.
    const sneaky = payload({
      question: `'; touch ${pwn}; echo '`,
      options: [{ label: "it's fine" }],
    });
    const result = await fx.decline(sneaky);

    assert.equal(result, DELEGATED, 'the command decline is still a delegation');
    assert.equal(existsSync(out), true, 'the command ran and wrote its message');
    const message = readFileSync(out, 'utf8');
    assert.match(message, /reason=margin session=session-abc/, 'the session and reason are substituted');
    assert.match(message, /it's fine|it'\\''s fine/, 'the option label survives substitution');
    assert.equal(existsSync(pwn), false, 'a shell injection in the question text does not execute');
    assert.deepEqual(decisions(fx), ['notify-sent'], 'the command outcome is recorded');
    await fx.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. Shadow mode records the message it would have sent and sends nothing.

{
  const fx = fixture({
    settings: { mode: 'shadow', 'notify.url': NOTIFY_URL },
    config: { transport: 'url' },
  });
  await fx.start();
  await fx.decline(payload());
  assert.equal(fx.calls.length, 0, 'shadow sends nothing');
  assert.deepEqual(decisions(fx), ['notify-shadow'], 'shadow records the message it would have sent');
  await fx.stop();
}

// ── 7. Off by default: the descriptor's own default is the off switch.

{
  assert.equal(notify.settings.transport.default, 'off', 'the transport is off on a fresh install');
  assert.equal(notify.seam, null, 'no harness seam: the trigger arrives on the core channel');
  assert.equal(notify.seamClass, 'broadcast', 'the module observes and never rewrites');
}

console.log(MARKER);
