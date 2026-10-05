# ops/mnemosyne: a self-maintaining memory for dsh-mnemosyne

Scripts, systemd units and notes that keep a mnemosyne store healthy with nobody watching, and
alert a phone when they cannot. They run next to the `dsh-mnemosyne` plugin and its patches in
`patches/dsh-mnemosyne-*`.

**Principle: the system may add, hide and demote. It never deletes a memory.** Every loss seen
while running this store came from a step that deleted or wrote without proof: a TTL trim that
removed 1,814 rows, a fallback that wrote keyword fragments, a conflict step that hid a person's
own messages. `docs/operations-notes.md` has the evidence and the engine source lines behind each
decision.

## What runs

| When | Unit | Does |
| --- | --- | --- |
| daily 04:30 | `mnemosyne-daily` | backup, verify, `mnemosyne-maintain.py`, prune backups to 14, `mnemosyne-health.sh --unattended` |
| 1st of the month 05:10 | `mnemosyne-recall-probe` | asks a fixed question set and compares the hit rate at 5 with a recorded baseline |
| on any failure of the two above | `mnemosyne-notify@` | phone alert through Home Assistant |

`mnemosyne-maintain.py` does, in order: router check; stamp deliberate notes as distilled;
split each session's turns into topics with one model call; per-session sleep with the engine's
conflict step and model-refresh step switched off; accept only `method == 'llm'`; check every new
summary by rule; clear any expiry a summary inherited; hide the `[ASSISTANT]` originals behind an
accepted summary; compare row counts with the last run. `--force` consolidates rows of any age.
`--no-topics` gives one summary per session. `--dry-run` writes nothing.

## Install

1. Put the engine environment in one file that every consumer loads. The engine reads the
   summariser settings, the TTL and the prompt from the **environment only**; the matching
   `config.yaml` keys are inert.
   ```sh
   cp llm.env.example ~/.dsh/mnemosyne/llm.env     # edit the router URL and model
   ```
2. Copy the scripts and units. They use absolute paths because a systemd user unit has only
   `/usr/local/bin:/usr/bin` on its `PATH`.
   ```sh
   cp bin/* ~/.dsh/bin/ && chmod +x ~/.dsh/bin/mnemosyne-*
   cp systemd/mnemosyne-* ~/.config/systemd/user/
   cp systemd/dsh.service.d-mnemosyne.conf ~/.config/systemd/user/dsh.service.d/mnemosyne.conf
   ```
3. Edit the hard-coded paths. They are written for one machine (`/home/sil`, a mise Node path in
   `mnemosyne-health.sh`, the Home Assistant skill path in `mnemosyne-notify.sh`).
4. Set the engine config and enable the timers.
   ```sh
   # ~/.dsh/mnemosyne/config.yaml
   #   auto_sleep_enabled: false     # only the guarded timer consolidates
   #   sync_roles: user,assistant
   systemctl --user daemon-reload
   systemctl --user enable --now mnemosyne-daily.timer mnemosyne-recall-probe.timer
   systemctl --user restart dsh      # loads llm.env into the daemon
   ```
5. Build the recall probe set and record a baseline (see below), then run
   `bash ~/.dsh/bin/mnemosyne-health.sh` and `systemctl --user start mnemosyne-daily.service`.

## Not in this folder, on purpose

- **`llm.env`.** Host configuration. `llm.env.example` has the same keys.
- **The recall probe set and its baseline.** The probe questions are paraphrases of the owner's
  own memories, so they are memory text and stay local. To rebuild: pick 20 to 30 memories, write
  one natural question for each, store `{"positive":[{"id","probe"}]}` in
  `~/.dsh/mnemosyne/recall-probes.json`, run
  `mnemosyne-recall-probe.py --set-baseline`. The alarm is baseline minus 3 probes, because
  identical runs move by about two.
- **Backups, row ids, and anything from the store.**

## Health checks (`mnemosyne-health.sh`)

Integrity, a write and read round trip, capture arriving, injection running, old rows surviving,
oldest unconsolidated row, then five that only make sense for a system running alone: the daily
job last succeeded within 36 h, no row count fell, no short human message is hidden from recall,
summaries are still being written, and the alert channel has no recorded failure. `--unattended`
skips the two checks that ask whether a session has been used lately, and alerts on failure.

## Known limits

- The rule checks on summaries catch invented identifiers. They do not prove a summary kept every
  decision. A model judge was dropped on purpose: a pass would not make deleting sources safe.
- The topic split is one more model call. A wrong split makes odd summaries, never data loss, and
  an invalid answer falls back to one summary per session. A topic that straddles the age cutoff is
  split across two days.
- Raw `[USER]` captures are kept and are now the largest source of recall noise. If the monthly
  probe falls, demote old raw rows in recall; do not delete them.
- A dead router stops both the work and, if 1Password is also unreachable, the alert path. The
  36-hour check and the alert-channel check help only if something else reaches the owner.

## `tools/`

One-off tools used to partition the store by project: `route-global-rows.mjs` (dry run by default,
refuses on any id not in the expected state, writes reverse SQL) and `migrate-seedwise-rows.mjs`.
Kept because they document how the store was partitioned and carry the reversal method.
