/**
 * The notification transport: rate limited, never throwing, and inert until a
 * transport URL is configured.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

/** A core with a controllable clock and a counting fetch. */
function rig(values, handler) {
  const settings = { get: (key) => values[key] };
  let clock = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const core = createCore({ settings, fetchImpl, now: () => clock });
  return { core, calls, advance: (ms) => { clock += ms; } };
}

test('no transport configured means suppressed and no request', async () => {
  const { core, calls } = rig({}, () => ({ status: 200 }));
  assert.equal(await core.notifications.send('hello'), 'suppressed');
  assert.equal(calls.length, 0);
});

test('a send is sent once, then rate limited, then sent again after the interval', async () => {
  const { core, calls, advance } = rig({ 'notify.url': 'https://hook.invalid/x', 'notify.maxPerHour': 2 }, () => ({ status: 200 }));
  assert.equal(await core.notifications.send('one'), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).text, 'one');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');

  advance(30_000);
  assert.equal(await core.notifications.send('two'), 'suppressed');
  assert.equal(calls.length, 1, 'a suppressed send must not reach the transport');
  assert.equal(core.notifications.stats().suppressed, 1);

  advance(31_000);
  assert.equal(await core.notifications.send('three'), 'sent');
  assert.equal(calls.length, 2);

  // The hourly ceiling is reached at two, so the one after the interval is held.
  advance(61_000);
  assert.equal(await core.notifications.send('four'), 'suppressed');
  assert.equal(calls.length, 2);
  assert.equal(core.notifications.stats().suppressed, 2);
  assert.equal(core.notifications.stats().sent, 2);
});

test('a failing transport is failed, never thrown', async () => {
  const thrown = rig({ 'notify.url': 'https://hook.invalid/x' }, () => {
    throw new Error('socket closed');
  });
  assert.equal(await thrown.core.notifications.send('x'), 'failed');

  const rejected = rig({ 'notify.url': 'https://hook.invalid/x' }, () => ({ status: 500 }));
  assert.equal(await rejected.core.notifications.send('x'), 'failed');
  assert.equal(rejected.core.notifications.stats().failed, 1);
});
