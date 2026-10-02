#!/usr/bin/env node
/**
 * Renderer gate for @local/dsh-linear: loads the real client.js under a stub
 * module loader, then asserts on the React element tree renderMarkdown and
 * fuzzyScore produce. Fails if the markdown subset regresses (headings, code,
 * lists, checkboxes, links, issue keys) or if raw HTML ever becomes an element.
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The installed profile supplies react; DSH_PROFILE_DIR wins when the harness
// runs with a profile, so the test works on any machine/profile name.
const PROFILE_NM = process.env.DSH_PROFILE_DIR
  ? join(process.env.DSH_PROFILE_DIR, 'node_modules')
  : join(homedir(), '.dsh', 'profiles', 'web', 'node_modules');
const require_ = createRequire(import.meta.url);
const React = require_(join(PROFILE_NM, 'react'));

let failures = 0;
const ok = (msg) => console.log(`ok: ${msg}`);
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures = 1; };

// Stub the browser module loader, then load the client half.
const hook = {};
globalThis.__DSH_LINEAR_TEST__ = hook;
let spec = null;
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.location = { origin: 'http://127.0.0.1:3081' };
await import(new URL('./client.js', import.meta.url).href);

if (!spec || spec.id !== '@local/dsh-linear') fail(`module registered under ${spec?.id}`);
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
if (mod.inject.includes('betterSidebar')) ok('entry injects betterSidebar');
else fail('entry injects betterSidebar');
if (typeof mod.apply === 'function') ok('apply exported');
else fail('apply exported');

const { renderMarkdown, fuzzyScore } = hook;
if (!renderMarkdown || !fuzzyScore) { fail('test hook exposes renderer'); process.exit(failures); }

/** Flatten the element tree into types + text. */
function walk(node, out = { types: [], text: [], hrefs: [] }) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === 'object' && node.type) {
    out.types.push(typeof node.type === 'string' ? node.type : 'component');
    if (node.props?.href) out.hrefs.push(node.props.href);
    walk(node.props?.children, out);
    return out;
  }
  if (typeof node === 'string') out.text.push(node);
  return out;
}

const SAMPLE = [
  '## Title', '',
  'A **bold** and *italic* and `code` and ~~gone~~ line with a [link](https://example.com/x) and SEE-123 key.', '',
  '```js', 'const x = <1>;', '```', '',
  '> quoted line', '',
  '- [ ] todo item', '- [x] done item', '- plain item', '',
  '1. first', '2. second', '',
  '![shot](https://example.com/a.png)', '',
  '---', '',
  'auto https://example.com/y here', '',
  '<script>alert(1)</script>',
].join('\n');

const t = walk(renderMarkdown(SAMPLE, 'https://linear.app/silverycaster'));
const has = (type) => t.types.includes(type);
for (const type of ['h2', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'img', 'a', 'p']) {
  has(type) ? ok(`renders <${type}>`) : fail(`renders <${type}>`);
}
t.text.join(' ').includes('☑') ? ok('renders checked checkbox') : fail('renders checked checkbox');
t.hrefs.includes('https://linear.app/silverycaster/issue/SEE-123')
  ? ok('SEE-123 links to the workspace issue URL')
  : fail(`SEE-123 link (got: ${JSON.stringify(t.hrefs)})`);
t.hrefs.includes('https://example.com/x') ? ok('markdown link href') : fail('markdown link href');
t.hrefs.includes('https://example.com/y') ? ok('bare URL autolinked') : fail('bare URL autolinked');
t.hrefs.every((href) => /^https?:/.test(href)) ? ok('every href is http(s)') : fail('every href is http(s)');
t.types.includes('script') ? fail('raw HTML became an element') : ok('raw HTML stays escaped text');
t.text.join(' ').includes('<script>') ? ok('script text preserved as text') : fail('script text preserved as text');
t.text.join(' ').includes('const x = <1>;') ? ok('fenced code preserved') : fail('fenced code preserved');

// Empty / null inputs must render without throwing.
try { renderMarkdown(null, null); renderMarkdown('', null); ok('null and empty inputs render'); }
catch (e) { fail(`null and empty inputs render: ${e.message}`); }

// Fuzzy scoring.
const issue = { identifier: 'SEE-103', title: 'Redesign the recommendation unit' };
fuzzyScore('see-103', issue) !== null ? ok('exact identifier matches') : fail('exact identifier matches');
fuzzyScore('redes unit', issue) !== null ? ok('multi-word subsequence matches') : fail('multi-word subsequence matches');
fuzzyScore('see-10', issue) !== null ? ok('prefix matches') : fail('prefix matches');
fuzzyScore('zzqqxx', issue) === null ? ok('nonsense rejected') : fail('nonsense rejected');

process.exit(failures);
