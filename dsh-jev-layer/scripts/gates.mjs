/**
 * The whole gate table, in one run.
 *
 * Every `scripts/gate-*.mjs` is an assert script that exercises one real artifact
 * and prints a unique `GATE-…-OK` marker as its last line after every assertion
 * passes. This runner executes them all, in a deterministic order — the module
 * list first, then ticket order, then the live install gate, which boots a server
 * and so runs last — prints each marker as it appears, and ends with one summary
 * line.
 *
 * Usage:
 *   node scripts/gates.mjs              every gate, including the live one
 *   node scripts/gates.mjs --skip-live  every gate that needs no profile
 *
 * Exit code is 0 only when every gate passed. The summary line is exactly
 * `GATES-ALL-PASS`, or `GATES-FAILED: <comma-separated names>`.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_DIR = join(ROOT, 'scripts');
const MARKER = /^GATE-[A-Z0-9-]+-OK$/;
/** A gate that boots a real profile is slower; the rest are in-process. */
const TIMEOUT_MS = 900_000;

const skipLive = process.argv.includes('--skip-live');

/** Deterministic order: the static module check, then ticket number, then name. */
function order(name) {
  if (name === 'gate-modules.mjs') return [0, '', name];
  const ticket = /^gate-t(\d+)-(.+)\.mjs$/.exec(name);
  if (ticket) return [Number(ticket[1]), ticket[2], name];
  return [99, name, name];
}

const files = readdirSync(SCRIPT_DIR)
  .filter((name) => name.startsWith('gate-') && name.endsWith('.mjs'))
  .filter((name) => !(skipLive && name === 'gate-live.mjs'))
  .sort((a, b) => {
    const left = order(a);
    const right = order(b);
    if (left[0] !== right[0]) return left[0] - right[0];
    return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
  });

const failures = [];
let passed = 0;

for (const file of files) {
  const run = spawnSync(process.execPath, [join(SCRIPT_DIR, file)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  const markers = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => MARKER.test(line));

  if (run.status === 0 && markers.length > 0) {
    for (const marker of markers) {
      console.log(`  ok   ${file}  ${marker}`);
      passed += 1;
    }
    continue;
  }

  const reason =
    run.error?.message
    ?? (run.status === 0
      ? 'exited 0 without printing a GATE-…-OK marker'
      : `exit ${run.status}: ${(stderr.trim().split('\n').pop() || 'no output')}`);
  failures.push(file);
  console.log(`  FAIL ${file}  ${reason}`);
}

if (failures.length === 0) {
  console.log(`GATES-ALL-PASS (${passed} markers, ${files.length} scripts)`);
} else {
  console.log(`GATES-FAILED: ${failures.join(', ')}`);
  process.exitCode = 1;
}
