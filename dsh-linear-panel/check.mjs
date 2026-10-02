#!/usr/bin/env node
/**
 * Runnable self-check for @local/dsh-linear: the class of defects that would
 * silently break activation — module-id mismatch, missing inject packages,
 * patch/manifest disagreement, syntax errors.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const assert = (ok, msg) => { if (!ok) { console.error(`FAIL: ${msg}`); process.exitCode = 1; } else console.log(`ok: ${msg}`); };

const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const client = readFileSync(join(dir, 'client.js'), 'utf8');
const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');

// 1. Module id registered by the client half equals the package name.
const id = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
assert(id === pkg.name, `client module id "${id}" === package name "${pkg.name}"`);

// 2. Bundle patch inserts a row of this package under a unique entry id.
assert(patch.includes(`name: '${pkg.name}'`), 'cordis.patch.yml inserts this package');
const rowId = patch.match(/id:\s*([^\s]+)/)?.[1];
assert(rowId && rowId !== pkg.name, `row id "${rowId}" is unique (not the package name)`);

// 3. Every dsh.client.inject package exists in the installed module set.
const dshBin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim();
const dshRoot = execFileSync('realpath', [dshBin], { encoding: 'utf8' }).trim();
const pkgsRoot = join(dirname(dirname(dshRoot)), 'node_modules', '@deepseek-ai');
for (const dep of pkg.dsh.client.inject) {
  assert(existsSync(join(pkgsRoot, dep.replace('@deepseek-ai/', ''))), `inject package ${dep} exists`);
}

// 4. Syntax of both halves.
for (const file of ['index.js', 'client.js']) {
  try {
    execFileSync(process.execPath, ['--check', join(dir, file)], { stdio: 'pipe' });
    assert(true, `${file} parses`);
  } catch (err) {
    assert(false, `${file} parses: ${err.stderr}`);
  }
}
