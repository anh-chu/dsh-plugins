# dsh-mnemosyne: the MEMORIA panel always renders zeros

Upstream: `dsh-mnemosyne` 0.8.1, installed from
`github:rebron1900/dsh-mnemosyne#65f36a6ab57cdf4a7dec93d046a0c1e24006f00c`
Repo: https://github.com/rebron1900/dsh-mnemosyne

## Bug

The dashboard's MEMORIA section — Overview, Facts, Timelines, Instructions, KG, Preferences —
reports **0** for every counter, `no data` for every per-table tab, and `no data` under Top Sessions,
no matter what the database holds. On the machine where this was found the SQLite file held **71**
`memoria_facts`, **35** `memoria_instructions`, **1** `memoria_timelines`, **1** `memoria_preferences`
and **1** `memoria_kg`.

Cause: the dashboard's read-only query adapter gates every table read behind a single allow-list, and
the six `memoria_*` tables are missing from it. From `src/index.js` (the adapter is embedded Python):

```python
def tables_present():
    allowed = ("working_memory", "episodic_memory", "memories", "triples", "consolidation_log")
    ...
TABLES = tables_present()

def count_rows(table):
    return connection.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] if table in TABLES else 0
```

`memoria_stats` calls `count_rows()` once per `memoria_*` table, and `read_memoria_list()` begins
`if table_name not in MEMORIA_TABLE_COLUMNS or table_name not in TABLES: return {"items": []}`. Both
therefore answer 0 / empty **by construction**, whatever the database holds. `memoria_stats` also
builds Top Sessions by iterating the same tables and skipping any not in `TABLES`, which is why that
panel says "no data".

The client half is fine and does the right thing — `assets/dashboard/static/app.js` requests
`/mnemosyne/dashboard/api/memoria/stats` and per-table lists (`loadMemoriaTable('memoriaFacts', …)`),
and the provider routes those to `memoria_stats` / `memoria_list`. Only the allow-list is wrong.

### Reproduce

Open the dashboard (sidebar → Mnemosyne → MEMORIA) while any `memoria_*` table has rows.

- expected: the real counts, e.g. Facts 71
- actual: Facts 0, Timelines 0, Instructions 0, Preferences 0, KG 0, persona 0, Top Sessions "no data"

Confirm the data is really there, independently of the panel:

```sh
sqlite3 ~/.dsh/mnemosyne/mnemosyne.db \
  "select 'memoria_facts', count(*) from memoria_facts
   union all select 'memoria_instructions', count(*) from memoria_instructions;"
```

## Fix (`dsh-mnemosyne@0.8.1.patch`)

Adds the six tables to the allow-list:

```python
allowed = ("working_memory", "episodic_memory", "memories", "triples", "consolidation_log",
           "memoria_facts", "memoria_timelines", "memoria_instructions",
           "memoria_preferences", "memoria_kg", "memoria_persona")
```

Every other use of `TABLES` in the adapter is a membership test — `if table not in TABLES`,
`if "triples" not in TABLES`, `"consolidation_log" in TABLES` — so widening the set only *enables* the
memoria paths. The working-memory, legacy-memories, triples and consolidation paths are untouched,
and nothing iterates `TABLES` in a way that a larger set would change.

## Test

```sh
node test/memoria-counts.test.mjs
```

The check fails on upstream 0.8.1 and passes with the patch. It asserts, statically, that the
allow-list admits all six tables, and — when the database is present — that every `memoria_*` table
that exists in the file is admitted, i.e. that the panel-visible count equals the real count.
Overrides: `DSH_MNEMOSYNE_DIR` (default `~/.dsh/profiles/web/node_modules/dsh-mnemosyne`) and
`MNEMOSYNE_DB` (default `~/.dsh/mnemosyne/mnemosyne.db`).

Verified two ways: against the unpatched 0.8.1 source it fails **11 of 17** assertions and exits 1,
naming the tables it hides (`memoria_facts: real=71 panel-visible=0  <-- the panel hides this`); with
the patch applied it passes all **17** and exits 0. `git apply --check` is clean against a fresh copy
of the installed package, and the patched file passes `node --check`.

## Install (web profile)

```sh
cp patches/dsh-mnemosyne@0.8.1.patch ~/.dsh/profiles/web/patches/
```

then in `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  dsh-mnemosyne@0.8.1: patches/dsh-mnemosyne@0.8.1.patch
```

and finally:

```sh
cd ~/.dsh/profiles/web && pnpm install
```

The dependency is GitHub-hosted; pnpm keys the patch by `name@version`, which is how the existing
`dsh-plugin-subscriptions@0.9.6` git-hosted patch is declared. **A `dsh web` restart is required for
the change to take effect** — the provider's embedded adapter is read at load time, so an install
alone leaves the running process on the old code.

## Note on what this does *not* fix

The MEMORIA counters are cosmetic: they report tiers produced by optional features. On this install
`triples` and `episodic_memory` are legitimately 0 because fact extraction is opt-in per write and
`sleep` consolidation has not been run — see the main session's notes. This patch only makes the panel
tell the truth about the tables that *do* have rows.
