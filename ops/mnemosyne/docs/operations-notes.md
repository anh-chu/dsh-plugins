# mnemosyne operations notes

Decisions, measurements and faults from running mnemosyne as the memory store behind the DSH harness, 2026-10-04 and 2026-10-05. Extracted from a longer local migration log. Row ids and memory text are kept out; counts and mechanisms are kept in.

## LLM summariser on (Plan C) and scope guidance — live 2026-10-05

**Why.** mneme distilled memories with a model (2,783 `summarize_compress` runs on
`openai-codex:gpt-5.6-luna`, 820 auto-dream consolidations). mnemosyne here had the summariser
off, so captures stayed raw: 145 `[USER]` rows, nothing distilled, and `sleep` without a model
writes one keyword fragment per memory (measured: 55.2% to 44.8% at 5). Agents rarely write
memories on purpose (15 rows in four days, 11 about the tooling itself), and mneme did not need
them to.

**What is live.**
- One shared file, `~/.dsh/mnemosyne/llm.env`, read by `dsh.service`, `mnemosyne-daily.service` and
  the shell scripts: summariser on, router `http://127.0.0.1:20129/v1`, model
  `codex/gpt-5.6-luna-low` (Codex subscription, cost 0), `LLM_N_CTX=24000`,
  `WM_TTL_HOURS=720`, and an English, conclusions-first `SLEEP_PROMPT`.
- `config.yaml`: `sync_roles: user,assistant`, `auto_sleep_enabled: false`.
- `mnemosyne-daily.sh`: backup, verify, router check, stamp `source=dsh` notes as distilled,
  consolidate each session with eligible rows, delete the `[ASSISTANT]` originals that were
  consolidated, warn on `method: aaak`. It exits 1 after the backup and prune if consolidation
  was skipped or degraded.
- `mnemosyne-health.sh`: loads `llm.env`; new check 7 fails when the oldest unconsolidated row
  passes 500 h (the trim deletes at 720 h).

**Why a file and not a plugin patch or config.yaml.** The engine reads every `LLM_*` value, the TTL
and the prompt from `os.environ` at import (`core/local_llm.py` lines 36-39). The `llm_*` keys in
config.yaml are inert for this path. The plugin's `buildEnv` bridge reaches only the process the
plugin spawns, and the daily timer is a separate process. Any shell that runs `mnemosyne` without
`MNEMOSYNE_WM_TTL_HOURS` trims at the 168 h default, so every script must load this file.

**Test on copies, before the switch.** 5 user messages plus 5 assistant replies became one English
summary. With the built-in prompt it summarised mostly the questions. With the conclusions-first
prompt it carried the findings (the exact-directory lookup, the `$HOME` refusal).

**Faults the tests found, each silent.**
1. `auto/*` routes on the router are disabled and `kc/*` models need credits. Name a concrete model.
2. Sleep consolidates rows older than TTL/2. With the TTL at 100 years the cutoff was five years in
   the past, so nothing was ever eligible.
3. Sleep groups by `source`. Migrated rows each carry their own UUID source, so they never group.
   Captured turns share `source=conversation`, so they do.
4. The default 2048-token window left about 1,000 tokens of input and split one session into many
   tiny summaries.
5. `mnemosyne sleep` covers only the default session. Consolidation runs per session through the
   helper.
6. A false test as the last command of a loop made the pipeline exit 1, and `set -e` skipped the
   backup prune. Fixed with an `if`.
7. systemd gives a unit only `/usr/local/bin:/usr/bin`. A bare `node` exited 127 on the first live
   timer run, although the same script passed from a shell. The script now pins the interpreter.

**Scope leak and its fix.** The plugin's system prompt said "use scope=global for facts that should
survive a new session". An agent in `seedwise/app` followed it and stored a Seedwise-only rule
(importance 1.0) in the shared pool. Moved to the Seedwise namespace; reverse SQL in
a reverse file kept in `~/.dsh/backups/`. The prompt and the tool description now say: workspace
for the current project, global only for facts true in every project. The `workspace` branch of
`mnemosyne_remember` also writes to the shared pool when no project is bound, because the unbound
fallback carries no session id. Patch in `anh-chu/dsh-plugins` at `235839f`, 18 assertions.

**Verified after the restart (pid 4170953, 14:39).**
- Daemon environment has `LLM_ENABLED=true`, router URL, model, `N_CTX=24000`, `WM_TTL_HOURS=720`
  and the 438-byte prompt.
- This session's system prompt and `mnemosyne_remember` description carry the new scope text.
- `[ASSISTANT]` rows are captured (19 so far, 812 characters at most, typed `error`).
- Health: 8 of 8. Oldest unconsolidated row: 87 h.
- Timer run: router answered, `Result=success`, 14 snapshots retained. It found no eligible
  session, which is correct: no row is 360 h old yet. The first run failed with status 127 (see 7).
- Recall on the 29 probes: **58.6% at 5 (17 of 29), 10.3% at 1**, measured from the namespace that
  owns each target (15 global, 14 Seedwise). Before: 55.2% at 5. The CLI default-namespace score
  of 20.7% is not comparable: it cannot see the 14 Seedwise targets, which now live in their own
  namespace. From the Seedwise namespace its 14 probes score 78.6% at 5.

**Known costs.**
- Raw `[ASSISTANT]` rows are recallable for about 15 days, until the timer consolidates and deletes
  them. They are truncated at 800 characters and may contain rendered-card JSON.
- If the router is down for 15 days, the trim starts deleting captures. The health alarm fires at
  500 h and gives about 9 days to react.
- The first real consolidation of live data happens when rows reach 360 h, around 2026-10-16. Check
  that run: `systemctl --user status mnemosyne-daily.service`, then read one summary.
  (Superseded by the next section: a forced run on 2026-10-05 already made nine summaries.)

## Self-maintaining memory — built 2026-10-05

**Goal.** A memory that keeps itself healthy with no person in the loop, and tells the owner by
phone when it cannot. **Principle: it may add, hide and demote. It never deletes.** Every loss on
this machine so far came from a step that deleted or wrote without proof (1,814 rows trimmed,
keyword fragments written, a conflict step that hid three of the owner's messages).

**How the design was made.** A first plan used a model to judge each summary and deleted raw rows
60 days after consolidation. Two rounds with a reviewer model (`codex/gpt-6-sol`; the Opus route is
not allowed in this session) found it unsafe, and each claim was checked against the engine source:
- A summary can be partial yet report `llm`: an oversized row is skipped, a failed chunk is dropped
  (`local_llm.py` ~385-420, ~635-648). So a pass cannot authorise deleting sources.
- The engine rewrites summaries by age (400 characters at 30 days, 300 at 180: `beam.py` ~7999-8040).
  An approved summary is not the one that survives.
- Raw rows win exact-word recall by design (`beam.py` ~7131). Deleting them removes the hits that
  make recall useful.
- A judge cannot undo what sleep already wrote: claims are committed first, then conflicts, model
  refresh and fact extraction (`beam.py` 8314-8531).
- Un-stamping a rejected summary's rows hands them back to the trim, which ignores `pinned`
  (`beam.py` 3885).
Dropped: the model judge, all deletion, the raw-share alarm, the retry table, automatic reclaim.

**What runs each day (`mnemosyne-daily.sh`, 04:30).**
1. backup, then `verify`
2. `mnemosyne-maintain.py`: router check; stamp `source=dsh` notes as distilled; per-session sleep;
   accept only `method == 'llm'` (`llm+aaak` fails); fail on engine `errors`; check every new
   summary by rule; hide the `[ASSISTANT]` originals behind an accepted summary; compare counts
   with the last run
3. prune backups to 14
4. `mnemosyne-health.sh --unattended`

**Summary checks (deterministic, precision only).** Reject a summary that: was not written by the
model; is under 120 characters; looks like the keyword fallback; lists no source rows; or contains
identifiers (backticked code, paths, `SEE-n` tickets, numbers of 3+ digits, commit hashes) that
are absent from its sources in more than 25% of cases. This catches invented facts. **It does not
prove coverage**: a summary can omit a decision and pass. A rejected summary is hidden, its rows
stay stamped (so the trim cannot reach them), and the run fails.

**Two engine steps switched off in our script, not patched in the engine.**
- Conflict step: `BeamMemory._detect_conflicts` is replaced by a function that finds nothing. It had
  hidden **three** human messages (the reviewer said two; the count was three, one from an earlier
  session). They were restored with a reverse file `~/.dsh/backups/unhide-3-human-rows-reverse.sql`.
- Model refresh: `agent_context = 'cron'` on every `Mnemosyne` object (`beam.py:8481`). The first
  forced run had written 34 proposal rows, 17 `canonical_facts`, and grown `facts` 90 to 163 and
  `memoria_facts` 80 to 144. Nothing in the plugin reads `canonical_facts`. Those rows were left in
  place; the 34 proposals are still recallable and still crowd recall (see Measured, below).

**Alarms (health script; checks 8 to 12 are new).**
- last successful maintenance older than 36 h (a timer that never starts cannot trigger
  `OnFailure=`, so this is a separate check)
- any fall in `[USER]`, summary or curated counts, between runs and during a run
- a short human `[USER]` message hidden from recall
- raw captures older than 30 days with no summary written in 45 days (consolidation stalled)
- the phone alert channel itself has a recorded failure (otherwise every other alarm is silent)
- oldest unconsolidated row over 500 h (existing)
- Checks 4 and 5 (capture in 24 h, injection batches) are skipped in unattended mode: at 04:40 the
  honest answer is often "no session today", and an alarm that cries every night is ignored.

**Monthly recall check (`mnemosyne-recall-probe.timer`, 1st of the month, 05:10).** Asks the 29
probes from the namespace that owns each target. Baseline 17 of 29 at 5 (58.6%) recorded
2026-10-05; alarm at 14 or fewer, because identical runs move by about two probes. It detects a
collapse, not a 5-point drift. Results append to `~/.dsh/mnemosyne/recall-history.jsonl`.

**Alert channel.** `notify-with-hass` (1Password via `op run`; the HA token never touches a file or
argv). `mnemosyne-notify@.service` is the `OnFailure=` target of the daily and probe units. The
script always exits 0 and writes `~/.dsh/mnemosyne/notify-failed.flag` when a send fails, so a
broken alert cannot hide the failure it reports. Verified: a unit run under systemd, a failing
throwaway unit reaching the phone, and a broken token degrading safely.

**Tests, all on copies unless stated.** Happy path; router down (nothing written, exit 1);
summariser disabled (no keyword fragments written, exit 1); six hand-made summaries (good accepted;
invented ticket and file, stub, keyword shape, `llm_used` false, no sources all rejected); the nine
real summaries from the live store (all accepted); a forced stub summary (hidden, rows stay stamped,
exit 1); a count drop between runs (reported); each new health check forced to fail; the recall
alarm quiet on an unchanged store (17/29) and loud with 12 targets hidden (9/29). Live: the full
daily unit succeeded, health passed 11 of 11, the probe unit succeeded.

**Bugs the tests found in my own work.** (a) The old daily script still deleted `[ASSISTANT]` rows;
replaced. (b) The first `OnFailure=` used `%n`, which produced `...service.service`; `%N` is right.
(c) The fault tests ran with `--unattended`, so four real alerts reached the phone. (d) A first
design deleted nothing in the store but the test of a "bad summary" showed one `[ASSISTANT]` row
hidden; that row was hidden on the live store before the test, not by it (checked).

**Measured, honestly.** After hiding the 40 `[ASSISTANT]` originals that a live summary covers,
recall on the owner's last 30 messages changed little: raw `[ASSISTANT]` 34.8% to 27.6% of results,
raw `[USER]` 28.8% to 34.3%, curated 25.0% to 25.4%, median score 0.20 to 0.19. The gap was filled
by raw `[USER]` rows, not by curated memory. Of 293 results, none was a hidden row. **Raw `[USER]`
rows are now the largest source of recall noise, and this plan does not remove them on purpose:
deleting them was judged unsafe.** The next lever, if the monthly probe falls, is to demote old raw
rows in recall without deleting them.

**Known limits.**
- The summariser has run live once (forced, nine summaries). It has not run unattended on rows that
  aged in naturally; that first happens around 2026-10-16. The daily unit has run live, found no
  eligible rows, and succeeded.
- Nothing checks the checker. If the model drifts, the identifier rule still passes summaries that
  omit decisions. The 29-probe check is the only independent signal.
- A dead router or a missing 1Password service account stops both the work and the alert path. The
  36-hour check and the alert-channel check cover this only if something else reaches the owner.
- The 34 model-refresh proposal rows and 17 canonical facts from the first forced run remain.

**Files.** `~/.dsh/bin/{mnemosyne-maintain.py, mnemosyne-notify.sh, mnemosyne-recall-probe.py,
mnemosyne-daily.sh, mnemosyne-health.sh}`; `~/.dsh/mnemosyne/{llm.env, recall-probes.json,
recall-baseline.json, recall-history.jsonl, maintain-state.json}`;
`~/.config/systemd/user/{mnemosyne-daily.service, mnemosyne-notify@.service,
mnemosyne-recall-probe.{service,timer}}`. Reverse files in `~/.dsh/backups/`:
`unhide-3-human-rows-reverse.sql`, `hide-assistant-originals-reverse.sql`.

## Topic-sized summaries — live 2026-10-05

**Problem.** The engine groups rows for one summary by `source`. Every captured turn has the source
`conversation`, so one summary covered a whole session. The `default` namespace holds all home-directory
work, so 130 turns of unrelated work became 3 summaries that read as a gist of a day.

**Change (script only; the engine is not patched).** `mnemosyne-maintain.py` now, per session:
1. Restores any leftover `conversation#…` source label from a crashed run.
2. Asks the model to split the eligible turns into topic segments. It accepts the answer only if every
   turn appears once and in order; segments under 3 turns merge into a neighbour; window capped at 200.
3. Sets `source = 'conversation#<n>-<slug>'` per segment for the length of one sleep.
4. Runs `sleep`, then restores `source = 'conversation'` in a `finally`.
Any invalid split, model failure or crash falls back to one summary per session and leaves no stray
label. `--no-topics` forces the old behaviour.

**Live result.** 13 topic summaries for `default` (3 to 28 rows each). The two old session-sized
summaries are hidden (`valid_until` set, not deleted); the one-row agent-note summary stays because no
topic summary covers it. Backup `a6c7a921f2ee1fa6`. 0 unconsolidated rows, 0 stray labels, verify and
health pass (11 of 11).

**Bug found and fixed: summaries born expired.** The engine gives a summary the earliest `valid_until`
of the rows it covers (`beam.py`, consolidation around line 8372). A group that contains an
`[ASSISTANT]` row hidden earlier therefore produced a summary that recall already skipped. 8 of the 13
topic summaries were born hidden. `mnemosyne-maintain.py` now clears an inherited expiry on every
summary that passes its checks. A copy test over rows with 44 hidden `[ASSISTANT]` rows wrote 13
summaries and none was expired. The first (unfixed) run affected only this topic run.

**Guard that caught it.** The swap step refuses to hide an old summary unless every source row it
covers is covered by a visible new one. It refused twice: once for the expiry bug, once for a single
agent note. Keep that check for any future re-summarising.

**Limits.** A topic that straddles the 360 h cutoff is split across two days. The split is one more
model call; a wrong split gives odd summaries, not data loss. Summaries still rank below exact-word
matches in recall, so a topic question often returns the raw turn first.

Reverse files in `~/.dsh/backups/`: `topic-redo-reverse.sql`, `topic-redo-unexpire-reverse.sql`.
