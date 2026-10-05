#!/usr/bin/env node
// Move Seedwise project knowledge out of the shared global memory pool into the
// Seedwise workspace namespace, so it stops being injected into unrelated
// sessions. Reversible: the source values are written to a manifest, and
// `mnemosyne backup` was taken immediately before.
//
//   node migrate-seedwise-rows.mjs            # dry run (default): change nothing
//   node migrate-seedwise-rows.mjs --apply    # perform the move in one transaction
//
// Two tables carry the partition, and both must move together:
//   working_memory(session_id, scope)  — the row that recall filters on
//   memories(session_id)              — the parallel record table
// The vector index is keyed by rowid and holds no partition column, so it needs
// nothing; nor do fts_working* (rowid-keyed, content only).
// No reindex: that has corrupted this store before when run against a live daemon.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const CLASSIFICATION = join(homedir(), ".dsh", "backups", "seedwise-classification.json");
const DB = join(homedir(), ".dsh", "mnemosyne", "mnemosyne.db");
const SEEDWISE_CWD = "/home/sil/seedwise/app";
const PLUGIN = join(homedir(), ".dsh", "profiles", "web", "node_modules", "dsh-mnemosyne");

// Resolve the namespace exactly as the plugin will, rather than hardcoding it.
const { resolveMemoryContext } = await import(join(PLUGIN, "src", "identity.js"));
const ctx = resolveMemoryContext({
  cwd: SEEDWISE_CWD,
  sessionId: "migration",
  config: { recallMode: "workspace" },
  dataDir: join(homedir(), ".dsh", "mnemosyne"),
});
if (!ctx.bound || !ctx.namespace) {
  console.error(`Refusing: ${SEEDWISE_CWD} resolved to ${ctx.mode}/${ctx.source}, not a bound workspace.`);
  process.exit(1);
}
const NS = ctx.namespace;

if (!existsSync(CLASSIFICATION)) {
  console.error(`Refusing: no classification at ${CLASSIFICATION}`);
  process.exit(1);
}
const { seedwise_ids: ids } = JSON.parse(readFileSync(CLASSIFICATION, "utf8"));
if (!Array.isArray(ids) || ids.length === 0) {
  console.error("Refusing: empty or malformed seedwise_ids");
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec("pragma busy_timeout = 15000");
const placeholders = ids.map(() => "?").join(",");

console.log(`namespace : ${NS}`);
console.log(`cwd       : ${SEEDWISE_CWD} (source=${ctx.source})`);
console.log(`rows      : ${ids.length}`);
console.log(`mode      : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`);

// Every id must exist in both tables, at the expected source partition, before a
// single row is touched. Exact ids only — never a content prefix.
const found = db
  .prepare(
    `select count(*) n from working_memory
      where id in (${placeholders}) and session_id='default' and scope='global'`,
  )
  .get(...ids).n;
const foundMem = db.prepare(`select count(*) n from memories where id in (${placeholders})`).get(...ids).n;
console.log(`matched in working_memory (default/global) : ${found}/${ids.length}`);
console.log(`matched in memories                        : ${foundMem}/${ids.length}`);
if (found !== ids.length || foundMem !== ids.length) {
  console.error("\nRefusing: the id set does not match the expected source state. Nothing was written.");
  process.exit(1);
}

const manifest = {
  generated_at: new Date().toISOString(),
  namespace: NS,
  cwd: SEEDWISE_CWD,
  applied: APPLY,
  reverse_sql: `update working_memory set session_id='default', scope='global' where id in (${ids
    .map((id) => `'${id}'`)
    .join(",")}); update memories set session_id='default' where id in (${ids
    .map((id) => `'${id}'`)
    .join(",")});`,
  ids,
};
writeFileSync(join(homedir(), ".dsh", "backups", "seedwise-migration-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest  : ~/.dsh/backups/seedwise-migration-manifest.json (includes reverse_sql)`);

if (!APPLY) {
  console.log("\nDry run complete. Nothing written.");
  process.exit(0);
}

db.exec("begin immediate");
try {
  const w = db
    .prepare(`update working_memory set session_id=?, scope='session' where id in (${placeholders})`)
    .run(NS, ...ids);
  const m = db.prepare(`update memories set session_id=? where id in (${placeholders})`).run(NS, ...ids);
  db.exec("commit");
  console.log(`\nupdated: working_memory ${w.changes}, memories ${m.changes}`);
} catch (err) {
  db.exec("rollback");
  console.error(`\nrolled back: ${err.message}`);
  process.exit(1);
}

// Read back the new partition, and prove nothing else moved.
const after = db
  .prepare("select session_id, scope, count(*) c from working_memory where id in (" + placeholders + ") group by session_id, scope")
  .all(...ids);
console.log("\nafter:");
for (const r of after) console.log(`  ${String(r.c).padStart(4)}  ${r.scope}  ${r.session_id}`);
console.log(`\nglobal pool now: ${db.prepare("select count(*) c from working_memory where session_id='default' and scope='global'").get().c} rows`);
console.log(`seedwise ns now: ${db.prepare("select count(*) c from working_memory where session_id=?").get(NS).c} rows`);
db.close();
