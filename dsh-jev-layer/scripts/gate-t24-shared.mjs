/**
 * Gate G-T24-1: guide.shared corrects exactly the agents it misled.
 *
 * The chain under test is the one the ticket specifies: this session's own
 * `send_message` calls give the recipient map, one judge question decides whether
 * the new text contradicts the old, and delivery goes to that recipient alone.
 *
 * Controls, because a gate that cannot fail is not evidence:
 * - a session that sent nothing must be a pure no-op and must not even ask the judge;
 * - a recipient whose text did NOT change must receive nothing and must not be judged;
 * - an agent that was told nothing inconsistent must never be injected;
 * - the observer returns nothing, so it cannot touch the publisher's decision.
 *
 * Run: node scripts/gate-t24-shared.mjs
 */
import assert from 'node:assert/strict';

import guideShared, { } from '../packages/plugin/src/modules/guide-shared.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const A = 'agent-a';
const B = 'agent-b';

/** A synthetic api matching docs/CONTRACT.md. */
function makeApi({ contradiction = 0.95, shadow = false } = {}) {
  const calls = { ask: [], injected: [] };
  const ledger = [];
  return {
    calls,
    ledger,
    api: {
      id: 'guide.shared',
      config: {
        get: (key) =>
          ({ minProbability: 0.8, lookbackMessages: 40, maxPerSession: 3 })[key],
      },
      judge: {
        configured: true,
        async ask(state, questions, opts) {
          calls.ask.push({ state, questions, opts });
          return { q: { noul: contradiction } };
        },
      },
      budget: { tryAcquire: () => true },
      shadow: { isShadow: () => shadow },
      ledger: { append: (row) => ledger.push(row) },
      agents: { get: (id) => (id === A || id === B ? { id } : undefined) },
      inject: (agent, message) => {
        calls.injected.push({ agentId: agent.id, message });
        return true;
      },
      log: { warn() {} },
      seams: SEAMS,
    },
  };
}

/** A session whose history is the send_message calls this sender made. */
function eventFor(sessionId, sends) {
  const history = sends.map(([recipientId, text]) => ({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        id: `call-${recipientId}-${text.length}`,
        name: 'send_message',
        arguments: JSON.stringify({ agent_id: recipientId, message: text }),
      },
    ],
  }));
  return { agent: { session: { id: sessionId, deriveMessages: () => history } }, messages: [] };
}

const TOLD = 'the parser reads the file at line 118';
const CORRECTED = 'the parser reads the file at line 220';

/**
 * The host replays the WHOLE appended history on every step, so the fixtures are
 * cumulative and each step re-sends everything. A pruned history hides a state
 * machine that thrashes: the first run of this gate did exactly that, and the
 * independent review caught it.
 */
const ONE_RECIPIENT = [[A, TOLD], [B, 'unrelated status note']];
const AFTER_CORRECTION = [[A, TOLD], [B, 'unrelated status note'], [A, CORRECTED]];

// ── 1. A session that sent nothing is a no-op and costs no judgement.
{
  guideShared.stop();
  const { api, calls } = makeApi();
  const out = await guideShared.handle(eventFor('s-none', []), api);
  assert.equal(out, undefined, 'the observer returns nothing, so the decision is untouched');
  assert.equal(calls.ask.length, 0, 'nothing sent means no judgement');
  assert.equal(calls.injected.length, 0, 'nothing sent means nothing injected');
}

// ── 2. First telling is not a correction.
{
  guideShared.stop();
  const { api, calls } = makeApi();
  await guideShared.handle(eventFor('s-first', [[A, TOLD]]), api);
  assert.equal(calls.ask.length, 0, 'the first statement to a recipient is not a correction');
  assert.equal(calls.injected.length, 0);
}

// ── 3. The correction: one recipient corrected, the other left alone.
{
  guideShared.stop();
  const { api, calls, ledger } = makeApi();
  await guideShared.handle(eventFor('s-fix', ONE_RECIPIENT), api);
  assert.equal(calls.injected.length, 0, 'nothing is corrected before the text changes');

  const out = await guideShared.handle(eventFor('s-fix', AFTER_CORRECTION), api);
  assert.equal(out, undefined, 'the observer still returns nothing');
  assert.equal(calls.ask.length, 1, 'exactly one judgement for the one changed pair');
  assert.equal(calls.injected.length, 1, 'exactly one correction delivered');
  assert.equal(calls.injected[0].agentId, A, 'the correction goes to the misled recipient');
  assert.ok(
    calls.injected[0].message.source.form === 'notice',
    'the injected context is labelled as a notice, not a user prompt',
  );
  assert.ok(
    calls.injected[0].message.source.kind === 'dsh-jev-layer',
    'it carries this plugin own source kind',
  );
  assert.ok(
    ledger.some((row) => row.decision === 'correction-delivered'),
    'the delivery is attributable in the ledger',
  );

  // Settled state. The host keeps appending and replaying the same history, so a
  // state machine that compares history against its own updated memory will read
  // the OLD statement as a new change and inject a correction that reverses the
  // real one. Nothing may happen here.
  const asked = calls.ask.length;
  const injected = calls.injected.length;
  await guideShared.handle(eventFor('s-fix', AFTER_CORRECTION), api);
  assert.equal(calls.ask.length, asked, 'a settled session asks the judge nothing');
  assert.equal(calls.injected.length, injected, 'a settled session corrects nobody');

  // Once more, because a two-step ping-pong would pass the check above.
  await guideShared.handle(eventFor('s-fix', AFTER_CORRECTION), api);
  assert.equal(calls.injected.length, injected, 'still nobody on a second replay');

  // Repeating the current text is not a change either.
  await guideShared.handle(eventFor('s-fix', [...AFTER_CORRECTION, [A, CORRECTED]]), api);
  assert.equal(calls.injected.length, injected, 're-sending the current text is not a change');
}

// ── 4. Positive control for the detector: a repeat of the SAME text is not a correction.
{
  guideShared.stop();
  const { api, calls } = makeApi();
  await guideShared.handle(eventFor('s-same', [[A, TOLD]]), api);
  await guideShared.handle(eventFor('s-same', [[A, TOLD]]), api);
  assert.equal(calls.ask.length, 0, 'identical text must not even reach the judge');
  assert.equal(calls.injected.length, 0, 'identical text corrects nobody');
}

// ── 5. A judge that does not call it a contradiction delivers nothing.
{
  guideShared.stop();
  const { api, calls } = makeApi({ contradiction: 0.2 });
  await guideShared.handle(eventFor('s-weak', [[A, TOLD]]), api);
  await guideShared.handle(eventFor('s-weak', [[A, CORRECTED]]), api);
  assert.equal(calls.ask.length, 1, 'the pair was judged');
  assert.equal(calls.injected.length, 0, 'below the threshold nothing is delivered');
}

// ── 6. Shadow records the correction and delivers nothing.
{
  guideShared.stop();
  const { api, calls, ledger } = makeApi({ shadow: true });
  await guideShared.handle(eventFor('s-shadow', [[A, TOLD]]), api);
  await guideShared.handle(eventFor('s-shadow', [[A, TOLD], [A, CORRECTED]]), api);
  assert.equal(calls.injected.length, 0, 'shadow mode injects nothing');
  assert.ok(
    ledger.some((row) => row.mode === 'shadow' && row.wouldBe === 'inject'),
    'shadow mode still records what it would have done',
  );
}

// ── 7. The descriptor itself: an observer that owns no exclusive seam.
{
  assert.equal(guideShared.id, 'guide.shared');
  assert.equal(guideShared.seam, SEAMS.AGENT_PRE_STEP);
  assert.equal(guideShared.seamClass, 'broadcast', 'it must never rewrite the decision');
}

console.log('GATE-T24-SHARED-OK');
