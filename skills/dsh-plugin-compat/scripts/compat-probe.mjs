// CDP probe for a DSH web profile: owns its own Chrome tab, installs boot-time
// error hooks, then reports what the page actually shows and what was thrown.
//
//   node scripts/compat-probe.mjs <token|''> <port> [cdp-base]
//
// The token is the one printed by `dsh web` (single use). Pass '' when the
// browser profile already holds the auth cookie for that authority. CDP_BASE
// env overrides the default http://127.0.0.1:9222. KEEP=1 leaves the tab open
// for follow-up evaluation with a second connection.
//
// Why this exists: the DSH boot screen reports only an entry's state
// ("<package>: failed"). It never prints the underlying error, and the client
// runtime can swallow it entirely (an undeclared service, for example, fails
// entry activation after a completely successful apply()). This probe is the
// cheapest way to see the real page and the real console.
const CDP = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const token = process.argv[2] || '';
const port = process.argv[3] || '3198';
const target = token ? `http://127.0.0.1:${port}/?token=${token}` : `http://127.0.0.1:${port}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (await fetch(CDP + '/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
const events = [];
let seq = 0;

const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r));

// Installed before any page script runs, so nothing is missed during boot.
const HOOK = `
  window.__probeErrors = [];
  window.addEventListener('error', (e) => {
    window.__probeErrors.push('ERROR: ' + (e.error ? (e.error.stack || String(e.error)) : e.message));
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    window.__probeErrors.push('REJECTION: ' + ((r && (r.stack || String(r))) || String(r)));
  });
  const origError = console.error;
  console.error = function (...a) {
    try { window.__probeErrors.push('CONSOLE.ERROR: ' + a.map((x) => (x && x.stack) || String(x)).join(' ')); } catch {}
    return origError.apply(console, a);
  };
`;

const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
await raw('Runtime.enable', {}, sessionId);
await raw('Log.enable', {}, sessionId);
await raw('Page.enable', {}, sessionId);
await raw('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, sessionId);
await raw('Page.navigate', { url: target }, sessionId);
await sleep(22000); // boot + client plugin activation

const evalIn = async (expression) => {
  const r = await raw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result && r.result.value !== undefined ? r.result.value : JSON.stringify(r.result);
};

console.log('target', targetId, '->', target);
console.log('\n=== url ===\n' + (await evalIn('location.href')));
console.log('\n=== page text ===\n' + String(await evalIn('document.body.innerText.slice(0,2000)')));
console.log('\n=== boot card ===\n' + String(await evalIn(
  `(function(){const el=document.querySelector('[data-dsh-boot]');return el?el.textContent.replace(/\\s+/g,' ').slice(0,800):'(none — shell booted)'})()`
)));
console.log('\n=== client module manifest (one entry) ===\n' + String(await evalIn(
  `(function(){const b=window.__DSH_BOOT__,m=${JSON.stringify(process.env.MATCH || '')};` +
  `if(!b||!b.entries)return '(no __DSH_BOOT__.entries)';` +
  `const e=m?b.entries.find(x=>JSON.stringify(x).includes(m)):void 0;` +
  `return JSON.stringify(e||b.entries[0]).slice(0,400)})()`
)));
console.log('\n=== errors captured in page ===\n' + String(await evalIn('JSON.stringify(window.__probeErrors || [], null, 1).slice(0,4000)')));

console.log('\n=== console / exception events ===');
for (const e of events) {
  const p = e.params || {};
  if (e.method === 'Runtime.consoleAPICalled') {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (process.env.ALL || /probe|fail|error|missing|cannot|undefined/i.test(text)) {
      console.log(`[console.${p.type}] ${text.slice(0, 1500)}`);
    }
  } else if (e.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    console.log('[exception]', (d.exception && (d.exception.description || d.exception.value)) || d.text);
  } else if (e.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
    console.log('[log.error]', String(p.entry.text).slice(0, 1500));
  }
}

if (!process.env.KEEP) await raw('Target.closeTarget', { targetId });
ws.close();
