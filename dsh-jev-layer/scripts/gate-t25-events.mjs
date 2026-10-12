/**
 * Gate G-T25-1: the in-process event channel.
 *
 * Asserts the real core channel and the real module api, not a mock of either:
 *   1. publishing a name nobody subscribes to is a no-op, not an error;
 *   2. every current subscriber is delivered to exactly once;
 *   3. unsubscribing stops delivery, and the unsubscribe is idempotent;
 *   4. a subscriber that throws does not stop the others being delivered to;
 *   5. a module really sees `api.events` through the registry.
 *
 * Positive control for (5): the same fixture is started twice, once with a core
 * that has a channel and once with a core that does not, so a gate that always
 * reported "function" could not pass.
 *
 * Run: node scripts/gate-t25-events.mjs
 */
import assert from 'node:assert/strict';
import { createEvents, createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';

const NAME = 'question/evaluated';

// 1. No subscriber: a no-op that reports zero.
{
  const events = createEvents();
  assert.equal(events.publish(NAME, { a: 1 }), 0, 'publish with no subscriber delivers to nobody');
  assert.equal(events.subscribers(NAME), 0);
}

// 2. Every subscriber, exactly once, in order.
{
  const events = createEvents();
  const seen = [];
  const offA = events.subscribe(NAME, (p) => seen.push(['a', p.callId]));
  events.subscribe(NAME, (p) => seen.push(['b', p.callId]));
  assert.equal(events.subscribers(NAME), 2);
  assert.equal(events.publish(NAME, { callId: 'c1' }), 2, 'both subscribers are delivered to');
  assert.deepEqual(seen, [['a', 'c1'], ['b', 'c1']], 'delivery is once each, in subscription order');

  // 3. Unsubscribe stops delivery, and is idempotent.
  offA();
  offA();
  assert.equal(events.subscribers(NAME), 1);
  seen.length = 0;
  assert.equal(events.publish(NAME, { callId: 'c2' }), 1);
  assert.deepEqual(seen, [['b', 'c2']], 'the unsubscribed listener hears nothing more');
}

// 4. A broken subscriber cannot take the publisher's decision down with it.
{
  const warnings = [];
  const events = createEvents({ log: { warn: (m) => warnings.push(m) } });
  const seen = [];
  events.subscribe(NAME, () => { throw new Error('subscriber exploded'); });
  events.subscribe(NAME, () => seen.push('ok'));
  assert.equal(events.publish(NAME, {}), 1, 'the healthy subscriber is still delivered to');
  assert.deepEqual(seen, ['ok']);
  assert.equal(warnings.length, 1, 'the failure is logged, not swallowed');
}

// 5. A module sees the channel through the real registry. Positive control
//    included: without a core channel the same fixture must see nothing.
async function apiSeesEvents(core) {
  let seen = 'not-started';
  const fixture = {
    id: 'probe',
    seam: 'tools/result',
    seamClass: 'broadcast',
    start(api) { seen = typeof api?.events?.publish; },
    handle() { return undefined; },
  };
  const ctx = {
    get: () => undefined,
    inject: () => () => {},
    on: () => () => {},
    logger: { warn() {}, info() {} },
    effect: (fn) => { fn(); return () => {}; },
  };
  const registry = createRegistry({ modules: [fixture], ctx, config: { probe: { enabled: true } }, core });
  await registry.start();
  return seen;
}

{
  const withChannel = await apiSeesEvents(createCore());
  assert.equal(withChannel, 'function', 'a module sees api.events.publish through the registry');
  const withoutChannel = await apiSeesEvents({});
  assert.equal(withoutChannel, 'undefined', 'positive control: no core channel means no api.events');
}

console.log('GATE-T25-EVENTS-OK');
