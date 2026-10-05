#!/usr/bin/env node
// Route the shared global pool's project-specific memories into each project's
// workspace namespace, so a Seedwise fact stops appearing in a dsh-plugins
// session and vice versa. Rows labelled "global" stay where they are: the pool
// is the cross-cutting corpus that every project still reads.
//
//   node route-global-rows.mjs            # dry run (default): change nothing
//   node route-global-rows.mjs --apply    # perform the moves, one transaction per project
//
// The labels come from the jev_ask classification in /tmp/mnemo-classify/out-*.json.
// Two tables carry the partition and both must move together:
//   working_memory(session_id, scope)  — the row recall filters on
//   memories(session_id)              — the parallel record table
// The vector index is rowid-keyed with no partition column, so it needs nothing,
// and neither does fts_working*. No reindex: that has corrupted this store before
// when run against a live daemon.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const DIR = "/tmp/mnemo-classify";
const DB = join(homedir(), ".dsh", "mnemosyne", "mnemosyne.db");
const PLUGIN = join(homedir(), ".dsh", "profiles", "web", "node_modules", "dsh-mnemosyne");
const DATA_DIR = join(homedir(), ".dsh", "mnemosyne");

// label -> the directory whose workspace owns those memories
const TARGETS = {
  seedwise: "/home/sil/seedwise/app",
  "dsh-plugins": "/home/sil/dsh-plugins",
  "wiki-viewer": "/home/sil/wiki-viewer",
  guppi: "/home/sil/guppi",
};

// Labels deliberately left in the shared pool. dsh-plugins stays global for now
// (owner's call, 2026-10-04): it is the monorepo holding the forks and skills, and
// its knowledge is wanted from every session, not only from inside that directory.
// Override with KEEP_GLOBAL="a,b"; an empty string routes everything.
const KEEP_GLOBAL = new Set(
  (process.env.KEEP_GLOBAL ?? "dsh-plugins").split(",").map((s) => s.trim()).filter(Boolean),
);

// --- collect the classification -------------------------------------------------
const outFiles = readdirSync(DIR).filter((f) => /^out-\d+\.json$/.test(f)).sort();
if (outFiles.length === 0) {
  console.error(`No classification files in ${DIR}`);
  process.exit(1);
}
const byId = new Map();
const dupes = [];
for (const f of outFiles) {
  const { results } = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  for (const { id, label } of results) {
    if (byId.has(id)) dupes.push(id);
    byId.set(id, label);
  }
}
const snapshot = JSON.parse(readFileSync(join(DIR, "rows-all.json"), "utf8"));
const snapIds = new Set(snapshot.map((r) => r.id));
const missing = [...snapIds].filter((id) => !byId.has(id));
const extra = [...byId.keys()].filter((id) => !snapIds.has(id));
console.log(`slices read      : ${outFiles.length} (${outFiles.join(", ")})`);
console.log(`rows in snapshot : ${snapIds.size}`);
console.log(`rows classified  : ${byId.size}`);
if (dupes.length) { console.error(`\nRefusing: ${dupes.length} rows classified more than once.`); process.exit(1); }
if (missing.length) { console.error(`\nRefusing: ${missing.length} rows unclassified (e.g. ${missing.slice(0, 3).join(", ")}).`); process.exit(1); }
if (extra.length) { console.error(`\nRefusing: ${extra.length} labels for ids outside the snapshot.`); process.exit(1); }

// Manual corrections, applied after the classifiers and before routing. Kept in
// their own file so a classifier's artifact stays exactly as it wrote it and every
// human decision is reviewable in one place: {"<id>": "<label>", ...}
const OVERRIDES_FILE = join(DIR, "overrides.json");
if (existsSync(OVERRIDES_FILE)) {
  const overrides = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"));
  let applied = 0;
  for (const [id, label] of Object.entries(overrides)) {
    if (!byId.has(id)) { console.error(`\nRefusing: override for ${id} is not in the snapshot.`); process.exit(1); }
    if (byId.get(id) !== label) { byId.set(id, label); applied += 1; }
  }
  console.log(`overrides        : ${Object.keys(overrides).length} declared, ${applied} changed a label`);
}

const unknown = [...new Set(byId.values())].filter((l) => l !== "global" && !TARGETS[l]);
if (unknown.length) { console.error(`\nRefusing: unknown label(s) ${unknown.join(", ")}`); process.exit(1); }

const byLabel = new Map();
for (const [id, label] of byId) {
  if (!byLabel.has(label)) byLabel.set(label, []);
  byLabel.get(label).push(id);
}
console.log(`\nclassification   : ${[...byLabel.entries()].sort((a, b) => b[1].length - a[1].length).map(([l, ids]) => `${l}=${ids.length}`).join("  ")}`);

// --- resolve each target namespace ----------------------------------------------
const { resolveMemoryContext } = await import(join(PLUGIN, "src", "identity.js"));
const namespaces = {};
for (const [label, cwd] of Object.entries(TARGETS)) {
  const m = resolveMemoryContext({ cwd, sessionId: "route", config: { recallMode: "workspace" }, dataDir: DATA_DIR });
  if (!m.bound || !m.namespace) { console.error(`\nRefusing: ${label} (${cwd}) resolved to ${m.source}, not bound.`); process.exit(1); }
  namespaces[label] = m.namespace;
}
console.log(`\ntargets          :`);
for (const [label, ns] of Object.entries(namespaces)) console.log(`  ${label.padEnd(12)} -> ${ns.slice(0, 46)}`);

// --- verify the source state, then move -----------------------------------------
const db = new DatabaseSync(DB);
db.exec("pragma busy_timeout = 15000");
const ph = (n) => Array.from({ length: n }, () => "?").join(",");
const CHECK = `select count(*) n from working_memory where id in (__) and session_id='default' and scope='global'`;

const moves = [];
for (const [label, ids] of byLabel) {
  if (label === "global") continue;
  if (KEEP_GLOBAL.has(label)) {
    console.log(`\n${label}: ${ids.length} rows — KEPT GLOBAL by request, not routed`);
    continue;
  }
  const atSource = db.prepare(CHECK.replace("__", ph(ids.length))).get(...ids).n;
  const inMemories = db.prepare(`select count(*) n from memories where id in (${ph(ids.length)})`).get(...ids).n;
  console.log(`\n${label}: ${ids.length} rows — ${atSource} still global, ${inMemories} mirrored in memories`);
  if (atSource !== ids.length || inMemories !== ids.length) {
    console.error(`Refusing: ${label}'s id set does not match the expected source state. Nothing was written.`);
    process.exit(1);
  }
  moves.push({ label, ids, ns: namespaces[label] });
}

const manifest = {
  generated_at: new Date().toISOString(),
  applied: APPLY,
  namespaces,
  counts: Object.fromEntries(moves.map((m) => [m.label, m.ids.length])),
  per_project: Object.fromEntries(
    moves.map((m) => [
      m.label,
      { namespace: m.ns, ids: m.ids,
        reverse_sql: `update working_memory set session_id='default', scope='global' where id in (${m.ids.map((i) => `'${i}'`).join(",")}); update memories set session_id='default' where id in (${m.ids.map((i) => `'${i}'`).join(",")});` },
    ]),
  ),
};
writeFileSync(join(homedir(), ".dsh", "backups", "routing-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest         : ~/.dsh/backups/routing-manifest.json (per-project reverse_sql)`);

if (!APPLY) {
  console.log("\nDry run complete. Nothing written.");
  process.exit(0);
}

for (const { label, ids, ns } of moves) {
  db.exec("begin immediate");
  try {
    const w = db.prepare(`update working_memory set session_id=?, scope='session' where id in (${ph(ids.length)})`).run(ns, ...ids);
    const m = db.prepare(`update memories set session_id=? where id in (${ph(ids.length)})`).run(ns, ...ids);
    db.exec("commit");
    console.log(`\n${label}: moved ${w.changes} working_memory + ${m.changes} memories -> ${ns.slice(0, 34)}…`);
  } catch (err) {
    db.exec("rollback");
    console.error(`\n${label}: rolled back — ${err.message}`);
    process.exit(1);
  }
}

console.log("\n--- after ---");
console.log(`global pool          : ${db.prepare("select count(*) c from working_memory where session_id='default' and scope='global'").get().c} rows`);
for (const [label, ns] of Object.entries(namespaces)) {
  console.log(`${label.padEnd(20)}: ${db.prepare("select count(*) c from working_memory where session_id=?").get(ns).c} rows`);
}
const orphan = db.prepare("select count(*) c from working_memory w left join memories m on m.id=w.id where m.id is null").get().c;
console.log(`rows in one table only: ${orphan}`);
console.log(`total rows           : ${db.prepare("select count(*) c from working_memory").get().c}`);
db.close();
