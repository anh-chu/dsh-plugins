#!/usr/bin/env node
/**
 * dsh-mnemosyne: the MEMORIA dashboard panel must be able to see the memoria_* tables.
 *
 * The provider's dashboard adapter gates every table read behind one allow-list
 * (`tables_present()` in the embedded Python inside src/index.js). Upstream 0.8.1
 * omits all six memoria_* tables from it, and the adapter's readers answer 0/empty
 * for anything outside the set:
 *
 *     def count_rows(table):
 *         return ... if table in TABLES else 0
 *     def read_memoria_list(table_name, query):
 *         if table_name not in MEMORIA_TABLE_COLUMNS or table_name not in TABLES:
 *             return {"items": []}
 *
 * so the panel renders zeros and "no data" however much data the file holds.
 *
 * This check therefore asserts the invariant that was violated: EVERY memoria_*
 * table that exists in the database must be admitted by the allow-list, so the
 * panel-visible count equals the real count. It fails on unpatched 0.8.1.
 *
 * Usage:  node test/memoria-counts.test.mjs
 * Env:    DSH_MNEMOSYNE_DIR  (default ~/.dsh/profiles/web/node_modules/dsh-mnemosyne)
 *         MNEMOSYNE_DB      (default ~/.dsh/mnemosyne/mnemosyne.db)
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_DIR =
  process.env.DSH_MNEMOSYNE_DIR || join(homedir(), '.dsh/profiles/web/node_modules/dsh-mnemosyne');
const DB_PATH = process.env.MNEMOSYNE_DB || join(homedir(), '.dsh/mnemosyne/mnemosyne.db');

const MEMORIA_TABLES = [
  'memoria_facts',
  'memoria_timelines',
  'memoria_instructions',
  'memoria_preferences',
  'memoria_kg',
  'memoria_persona',
];
const BASE_TABLES = [
  'working_memory',
  'episodic_memory',
  'memories',
  'triples',
  'consolidation_log',
];

let checks = 0;
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};
const ok = (msg) => {
  checks += 1;
  console.log(`  ok    ${msg}`);
};
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ---------------------------------------------------------------- the source
const entry = join(PLUGIN_DIR, 'src/index.js');
if (!existsSync(entry)) {
  console.error(`Cannot find the provider entry: ${entry}`);
  console.error('Set DSH_MNEMOSYNE_DIR to the installed dsh-mnemosyne package.');
  process.exit(2);
}
const source = readFileSync(entry, 'utf8');

// The allow-list is the only `allowed = (...)` in the embedded adapter.
const matches = [...source.matchAll(/allowed\s*=\s*\(([\s\S]*?)\)/g)];
if (matches.length !== 1) {
  console.error(`Expected exactly one 'allowed = (...)' declaration, found ${matches.length}`);
  process.exit(2);
}
const allowed = new Set([...matches[0][1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

console.log(`provider : ${entry}`);
console.log(`admitted : ${allowed.size} tables\n`);

// ------------------------------------------------------- static assertions
for (const t of BASE_TABLES) {
  expect(allowed.has(t), `${t} still admitted (no regression to the existing paths)`);
}
for (const t of MEMORIA_TABLES) {
  expect(allowed.has(t), `${t} admitted (the panel can count it)`);
}

// ----------------------------------------------------- dynamic assertions
// Mirror count_rows(): a table outside the allow-list reports 0 whatever it holds.
if (!existsSync(DB_PATH)) {
  console.log(`\n(database ${DB_PATH} not present — dynamic assertions skipped)`);
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const tableExists = (t) =>
    db.prepare("select count(*) c from sqlite_master where type='table' and name=?").get(t).c > 0;
  const rowCount = (t) => db.prepare(`select count(*) c from "${t}"`).get().c;

  console.log(`\ndatabase : ${DB_PATH}`);
  let compared = 0;
  for (const t of MEMORIA_TABLES) {
    if (!tableExists(t)) continue;
    compared += 1;
    const real = rowCount(t);
    const visible = allowed.has(t) ? real : 0; // exactly count_rows()'s rule
    expect(
      visible === real,
      `${t}: real=${real} panel-visible=${visible}${real > 0 && visible === 0 ? '  <-- the panel hides this' : ''}`,
    );
  }
  if (compared === 0) {
    console.log('  (no memoria_* tables in the file yet — nothing to compare)');
  }
  db.close();
}

// ------------------------------------------------------------------ verdict
console.log(`\n${checkedSummary()}`);
function checkedSummary() {
  return failures === 0
    ? `PASS — ${checks} assertions`
    : `FAIL — ${failures} of ${checks + failures} assertions failed`;
}
process.exit(failures === 0 ? 0 : 1);
