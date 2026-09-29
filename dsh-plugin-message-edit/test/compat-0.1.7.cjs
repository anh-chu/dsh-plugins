// Runnable check for the local DSH 0.1.7 compat fix in this vendored package.
//
// Loads the REAL client module (lib/client.js) in a sandbox and drives apply()
// with a 0.1.7-shaped `sessions` service that has no open(), asserting the
// polyfill routes navigation through uiWorkspace.openSession while the
// pre-0.1.7 shape and the missing-service error are both preserved.
//
//   node test/compat-0.1.7.cjs
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const clientPath = path.join(__dirname, '..', 'lib', 'client.js');
const src = fs.readFileSync(clientPath, 'utf8');

// --- minimal browser/loader shims -----------------------------------------
let captured = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  URL,
  window: { __ModuleLoader__: { load: (m) => { captured = m; } } },
  // NOTE: no `document`, no localStorage — the module guards both.
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'lib/client.js' });
if (!captured) throw new Error('module never registered via __ModuleLoader__');

// react stub: only used lazily inside components, which this check never renders.
const reactStub = new Proxy({}, {
  get: (t, prop) => {
    if (prop === 'createElement') return () => null;
    if (prop === 'Fragment') return 'fragment';
    return (...args) => args[0];
  },
});
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
});
if (typeof plugin.apply !== 'function') throw new Error('no apply() exported');

// --- mocks -----------------------------------------------------------------
const injected = [];
const slotsMock = {
  register: () => () => {},
  registerFactory: () => () => {},
  inject: (name, fn) => { injected.push([name, fn]); return () => {}; },
};

let listSubscribed = 0;
const sessionsMock = {
  // 0.1.7 shape: snapshot store with getSnapshot/subscribe — but NO open().
  list: {
    getSnapshot: () => ({ ids: ['s1'], byId: { s1: {} }, phase: 'ready' }),
    subscribe: () => { listSubscribed += 1; return () => {}; },
  },
};
let navigated = null;
const uiWorkspaceMock = { openSession: (id) => { navigated = id; return undefined; } };

const effectErrors = [];
const ctx = {
  get(key) {
    if (key === 'slots') return slotsMock;
    if (key === 'sessions') return sessionsMock;
    if (key === 'uiWorkspace') return uiWorkspaceMock;
    if (key === 'locale') return { bind: () => (k) => k, getLocale: () => ({ id: 'en' }), subscribe: () => () => {} };
    return undefined;
  },
  effect(fn) { try { return fn(); } catch (e) { effectErrors.push(e); return undefined; } },
  on() { return () => {}; },
};

// --- checks ----------------------------------------------------------------
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail: detail || '' }); };

plugin.apply(ctx); // the original bug threw here on 0.1.7

check('apply() does not throw without sessions.open', true);
check(
  'sessions.open polyfilled from uiWorkspace',
  typeof sessionsMock.open === 'function',
  'typeof=' + typeof sessionsMock.open
);

sessionsMock.open('session-test-1'); // the untouched call sites do exactly this
check('polyfill routes to uiWorkspace.openSession', navigated === 'session-test-1', 'navigated=' + navigated);
check('sessions.list subscription wired', listSubscribed >= 1, 'subscribed=' + listSubscribed);
check('conversation.view slot injected', injected.some(([n]) => n === 'conversation.view'), JSON.stringify(injected.map(([n]) => n)));
check('no effect() errors', effectErrors.length === 0, effectErrors.map(String).join('; '));

// control: pre-0.1.7 shape must still be honored untouched
const sessionsOld = { open: (id) => { navigated = 'old:' + id; }, list: sessionsMock.list };
plugin.apply({ ...ctx, get: (k) => (k === 'sessions' ? sessionsOld : ctx.get(k)) });
sessionsOld.open('session-test-2');
check('0.1.5-shaped sessions.open still honored', navigated === 'old:session-test-2', 'navigated=' + navigated);

// control: neither open nor uiWorkspace -> the original error still fires
let threw = null;
try {
  plugin.apply({ ...ctx, get: (k) => (k === 'sessions' ? { list: sessionsMock.list } : k === 'uiWorkspace' ? undefined : ctx.get(k)) });
} catch (e) { threw = e.message; }
check('missing both still throws original error', /Missing DSH session navigation service/.test(threw || ''), String(threw));

// --- report ----------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
}
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
