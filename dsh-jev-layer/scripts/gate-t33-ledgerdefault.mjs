/**
 * G-T33-1: the ledger is written to a built-in file with no configuration.
 *
 * `ledgerPath` defaulted to empty, which kept the ledger in memory. The records vanished
 * when the host exited, the status route reports only a count, and so no one could read
 * what a module decided without first finding and setting a path. The default is now
 * `<DSH_HOME>/dsh-jev-layer/ledger.jsonl`, `off` keeps memory only, and an explicit path
 * is honoured. The file is bounded: past 5 MiB it moves to `ledger.jsonl.1`.
 *
 * The check goes through the real resolver AND the real core, and reads the file back.
 *
 * Run: node scripts/gate-t33-ledgerdefault.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCore } from '../packages/core/src/index.js';
import { LEDGER_MAX_BYTES, resolveLedgerPath } from '../packages/plugin/src/config.js';

const root = mkdtempSync(join(tmpdir(), 'jev-ledger-default-'));
try {
  const home = join(root, 'home');

  // ── empty means the built-in file, and the directory is created ───────────
  const builtin = resolveLedgerPath('', { home });
  assert.equal(builtin, join(home, 'dsh-jev-layer', 'ledger.jsonl'), 'empty resolves to the file inside the DSH home');
  assert.equal(resolveLedgerPath(undefined, { home }), builtin, 'an unset value resolves the same way');
  assert.equal(resolveLedgerPath('   ', { home }), builtin, 'blank is empty');
  assert.ok(existsSync(join(home, 'dsh-jev-layer')), 'the directory is created');

  // ── a record written through the real core lands in that file ─────────────
  const core = createCore({ settings: { get: () => undefined }, now: () => 1, statePath: builtin });
  core.ledger.append({ featureId: 'rank.files', decision: 'ranked', wouldBe: 'auth/login.py', mode: 'enforce' });
  const lines = readFileSync(builtin, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1, 'one record, one line');
  assert.equal(lines[0].featureId, 'rank.files');
  assert.equal(lines[0].wouldBe, 'auth/login.py');

  // ── controls ──────────────────────────────────────────────────────────────
  assert.equal(resolveLedgerPath('off', { home }), undefined, 'off keeps the ledger in memory');
  assert.equal(resolveLedgerPath(' OFF ', { home }), undefined, 'off is case and space insensitive');
  const custom = join(root, 'elsewhere', 'mine.jsonl');
  assert.equal(resolveLedgerPath(custom, { home }), custom, 'an explicit path is honoured');
  assert.ok(existsSync(join(root, 'elsewhere')), 'and its directory is created');
  assert.equal(resolveLedgerPath(42, { home }), builtin, 'a non-string value falls back to the default, not a crash');

  // ── bounded: past the limit the file is moved aside, once ─────────────────
  writeFileSync(builtin, 'x'.repeat(LEDGER_MAX_BYTES + 1));
  assert.equal(resolveLedgerPath('', { home }), builtin, 'the same path is returned after rotation');
  assert.ok(existsSync(`${builtin}.1`), 'the oversized file moved to ledger.jsonl.1');
  assert.ok(!existsSync(builtin) || statSync(builtin).size === 0, 'and a fresh file starts empty');

  // ── an unusable path never throws: memory only ────────────────────────────
  writeFileSync(join(root, 'afile'), 'x');
  assert.equal(resolveLedgerPath(join(root, 'afile', 'sub', 'l.jsonl'), { home }), undefined, 'a path that cannot be made returns undefined');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('GATE-T33-LEDGERDEFAULT-OK');
