#!/usr/bin/env bash
# mnemosyne health check — answers "is memory writing and recalling working RIGHT NOW?"
#
# Every check below exists because that specific thing has broken, silently, at
# least once on this machine:
#   write    → a bad config.yaml value made the write filter drop EVERY write
#              (the YAML block scalar parsed as the regex "|", which matches
#              anything), so captures stopped without a single error in the logs
#   recall   → the engine stayed healthy while injection died: recallMode
#              "workspace" with no bound workspace made every session's read
#              target "unbound", and the prefetch's unbound branch declines to
#              inject. Nothing is logged; the context block simply stops.
#   trim     → the working-memory TTL trim deleted 655 migrated rows on a write
#
# So the checks are deliberately split: engine write, engine read, automatic
# capture, and automatic injection are four different things that fail
# independently. A round-trip probe alone would NOT have caught the injection
# failure — that is why it has its own check.
#
# Usage: bash ~/.dsh/bin/mnemosyne-health.sh [--unattended]
# Exit:  0 = all checks passed, 1 = something is broken
#
# --unattended is for the scheduled run (no person at a session). It SKIPS checks 4 and 5,
# which ask whether a session has been used lately: at 04:40 the honest answer is often
# no, and a check that false-alarms every night gets ignored. It adds the checks that
# only make sense for a system running alone (8 to 12 below), and sends a phone alert
# on failure.
set -uo pipefail
UNATTENDED=0; [ "${1:-}" = "--unattended" ] && UNATTENDED=1

export MNEMOSYNE_DATA_DIR="${MNEMOSYNE_DATA_DIR:-$HOME/.dsh/mnemosyne}"
# Load the same file the daemon and the daily timer load. The engine reads the TTL
# from the environment only, so a shell without it trims at the 168 h default: this
# script's own write probe would delete aged rows. Do not set LLM_ENABLED here.
set -a
# shellcheck disable=SC1091
[ -f "$MNEMOSYNE_DATA_DIR/llm.env" ] && . "$MNEMOSYNE_DATA_DIR/llm.env"
set +a
export MNEMOSYNE_EMBEDDING_MODEL="${MNEMOSYNE_EMBEDDING_MODEL:-BAAI/bge-small-en-v1.5}"
CLI="${MNEMOSYNE_CLI:-$HOME/.local/bin/mnemosyne}"
DB="$MNEMOSYNE_DATA_DIR/mnemosyne.db"
MARKER="HEALTHCHECK-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
note(){ printf '        %s\n' "$1"; }

# systemd gives a unit only /usr/local/bin:/usr/bin; a bare node exited 127 once already.
NODE=/home/sil/.local/share/mise/installs/node/24.14.1/bin/node
[ -x "$NODE" ] || NODE=node
q() { "$NODE" --input-type=module -e "$1" 2>/dev/null; }

echo "mnemosyne health check"
echo "  cli  : $CLI"
echo "  store: $DB"
echo

[ -f "$DB" ] || { bad "database missing at $DB"; echo; echo "1 check failed."; exit 1; }
[ -x "$CLI" ] || { bad "cli missing at $CLI"; echo; echo "1 check failed."; exit 1; }

# ── 1. engine integrity ───────────────────────────────────────────────────────
integrity=$(q "
import {DatabaseSync} from 'node:sqlite';
try { const db=new DatabaseSync('$DB',{readOnly:true});
  console.log(db.prepare('pragma quick_check').get().quick_check); } catch(e){ console.log('error: '+e.message); }
")
if [ "$integrity" = "ok" ]; then ok "store integrity (quick_check)"; else bad "store integrity: $integrity"; fi

# ── 2. write path ────────────────────────────────────────────────────────────
# A filter that drops everything reports "Stored: None" and no id.
write_out=$("$CLI" store "$MARKER health check probe" healthcheck 0.5 2>&1 | tail -1)
probe_id=$(printf '%s' "$write_out" | sed -n 's/.*Stored: *\([A-Za-z0-9_-]*\).*/\1/p')
if [ -n "$probe_id" ] && [ "$probe_id" != "None" ]; then
  ok "write path accepted a new memory ($probe_id)"
else
  bad "write path REJECTED the probe: $write_out"
  note "if this says 'Stored: None', the write filter is dropping everything —"
  note "check ~/.dsh/mnemosyne/config.yaml ignore_patterns (a YAML block scalar"
  note "there parses as the regex \"|\" in the plugin and matches every string)."
fi

# ── 3. read path (round trip) ────────────────────────────────────────────────
if [ -n "${probe_id:-}" ] && [ "$probe_id" != "None" ]; then
  recall_out=$("$CLI" recall "$MARKER" 5 --json 2>/dev/null)
  found=$(printf '%s' "$recall_out" | "$NODE" --input-type=module -e "
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
  try { const r=JSON.parse(s).results||[]; console.log(r.some(x=>x.id==='$probe_id') ? 'yes' : 'no'); }
  catch(e){ console.log('no'); } });" 2>/dev/null)
  if [ "$found" = "yes" ]; then
    ok "read path returned the memory just written (round trip)"
  else
    bad "read path did NOT return the memory just written"
    note "the row is in the store but recall cannot find it — check the embedding"
    note "model env (MNEMOSYNE_EMBEDDING_MODEL) matches what the store was built with."
  fi
fi

# ── 4. automatic capture (is anything still arriving?) ──────────────────────
if [ "$UNATTENDED" -eq 1 ]; then note "(checks 4 and 5 skipped: unattended run)"; else
cap=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
const n=db.prepare(\"select count(*) c from working_memory where metadata_json not like '%migrated_from%' and datetime(created_at) > datetime('now','-24 hours')\").get().c;
const t=db.prepare(\"select coalesce(max(created_at),'never') m from working_memory where metadata_json not like '%migrated_from%'\").get().m;
console.log(n+'|'+t);
")
cap_n=${cap%%|*}; cap_t=${cap##*|}
if [ "${cap_n:-0}" -gt 0 ] 2>/dev/null; then
  ok "automatic capture is arriving ($cap_n new memories in 24h, latest $cap_t)"
else
  bad "no automatic captures in the last 24h (latest ever: $cap_t)"
  note "either you have not used a session in a day, or autoSync is off / the"
  note "write filter is dropping them. Check ~/.dsh/settings.yaml mnemosyne.autoSync."
fi

# ── 5. automatic injection (the one that fails without logging) ──────────────
# Injection has a measurable signature: the pre-step prefetch recalls
# candidateK = max(topK*2, 10) rows, so it stamps a BATCH of ~8-10 rows with one
# identical last_recalled. An explicit mnemosyne_recall at the default top_k=5
# stamps ~5. A plain "was anything recalled lately?" check cannot tell those
# apart and would keep passing while injection was dead — so this one looks for
# the batch. Override the window with HEALTH_PREFETCH_WINDOW_MIN.
#
# CLOCK: last_recalled is written in LOCAL time (the plugin writes local values
# while created_at on the same row is UTC, and migrated rows are UTC with a 'Z').
# Comparing it against SQLite's UTC 'now' made every row look up to 7h newer than
# it is — "the last 120m" matched 414 rows instead of 76. Hence 'localtime' here.
prefetch_win="${HEALTH_PREFETCH_WINDOW_MIN:-120}"
inj=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
const n=db.prepare(\"select count(*) c from (select last_recalled, count(*) n from working_memory where datetime(last_recalled) > datetime('now','localtime','-$prefetch_win minutes') group by last_recalled having n >= 8)\").get().c;
const t=db.prepare(\"select coalesce(max(last_recalled),'never') m from working_memory where last_recalled is not null\").get().m;
console.log(n+'|'+t);
")
inj_n=${inj%%|*}; inj_t=${inj##*|}
if [ "${inj_n:-0}" -gt 0 ] 2>/dev/null; then
  ok "prefetch injection is running ($inj_n recall batches of >=8 rows in the last ${prefetch_win}m; latest recall $inj_t)"
  note "a batch is the prefetch's signature (it asks the engine for 10 candidates)"
else
  bad "NO prefetch batches of >=8 rows in the last ${prefetch_win}m (latest recall ever: $inj_t)"
  note "the engine can still recall perfectly while injection is dead — that is"
  note "exactly how it failed here, with nothing in any log. Check the read target:"
  note "  node -e \"import('$HOME/.dsh/profiles/web/node_modules/dsh-mnemosyne/src/identity.js').then(m=>console.log(m.resolveMemoryContext({cwd:'\$PWD',sessionId:'x',config:{recallMode:'session'},dataDir:'$MNEMOSYNE_DATA_DIR'})))\""
  note "a 'bound: false' means workspace mode with no '.mnemosyne-id' marker, and"
  note "the prefetch then declines to inject anything. If it prints bound:true and"
  note "there are still no batches, you simply have not used a session lately —"
  note "messages shorter than prefetchMinQueryLen skip the prefetch entirely."
fi

fi  # end of checks 4 and 5 (interactive only)

# ── 6. TTL trim cannot reach unconsolidated rows ─────────────────────────────
ttl=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
const old=db.prepare(\"select count(*) c from working_memory where datetime(timestamp) < datetime('now','-7 days')\").get().c;
const un=db.prepare('select count(*) c from working_memory where consolidated_at is null').get().c;
console.log(old+'|'+un);
")
old_n=${ttl%%|*}; un_n=${ttl##*|}
if [ "${old_n:-0}" -gt 0 ] 2>/dev/null; then
  ok "rows older than 7 days survive ($old_n of them; $un_n currently unconsolidated)"
  note "migrated rows carry a consolidated_at stamp, which the trim skips."
else
  bad "no rows older than 7 days — everything historical may have been trimmed"
fi

# ── 7. consolidation keeps ahead of the trim ─────────────────────────────────
# The trim deletes unconsolidated rows older than the TTL (720 h); sleep consolidates
# rows older than TTL/2 (360 h). If the daily timer cannot reach the router for two
# weeks, captures start to be deleted with nothing logged. Alarm at 500 h, which leaves
# about 9 days to fix it.
ttl_h="${MNEMOSYNE_WM_TTL_HOURS:-168}"
warn_h=$(( ttl_h * 500 / 720 ))
age=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
const r=db.prepare(\"select min(timestamp) m, cast((julianday('now','localtime')-julianday(min(timestamp)))*24 as integer) h from working_memory where consolidated_at is null\").get();
console.log((r.h ?? 0)+'|'+(r.m ?? 'none'));
")
age_h=${age%%|*}; age_t=${age##*|}
if [ "${age_h:-0}" -lt "$warn_h" ] 2>/dev/null; then
  ok "oldest unconsolidated row is ${age_h}h old (alarm at ${warn_h}h, trim at ${ttl_h}h)"
else
  bad "oldest unconsolidated row is ${age_h}h old, past the ${warn_h}h alarm (trim deletes at ${ttl_h}h)"
  note "oldest: $age_t. The daily timer is not consolidating. Check:"
  note "  systemctl --user status mnemosyne-daily.service"
  note "  curl -s $MNEMOSYNE_LLM_BASE_URL/models | head -c 200   # is the router up?"
  note "then run: bash ~/.dsh/bin/mnemosyne-daily.sh"
fi
if [ "${MNEMOSYNE_LLM_ENABLED:-false}" != "true" ]; then
  bad "MNEMOSYNE_LLM_ENABLED is not true in this environment (check ~/.dsh/mnemosyne/llm.env)"
fi

# ── 8. the daily timer is actually running ──────────────────────────────────
# OnFailure= alerts when the unit FAILS. It cannot see a timer that never starts, a
# disabled timer, or a host that was off for days. This check reads the last success the
# maintain script records, and alarms if it is older than 36 hours.
STATE="$MNEMOSYNE_DATA_DIR/maintain-state.json"
last=$(python3 -c "
import json,sys,datetime
try: d=json.load(open('$STATE'))
except Exception: print('none|9999'); sys.exit()
t=d.get('last_success')
if not t: print('none|9999'); sys.exit()
dt=datetime.datetime.fromisoformat(t)
h=(datetime.datetime.now(datetime.timezone.utc)-dt).total_seconds()/3600
print(t[:19]+'|'+str(int(h)))
" 2>/dev/null)
last_t=${last%%|*}; last_h=${last##*|}
if [ "${last_h:-9999}" -le 36 ] 2>/dev/null; then
  ok "the daily maintenance last succeeded ${last_h}h ago ($last_t UTC)"
else
  bad "the daily maintenance has not succeeded in ${last_h}h (last success: $last_t)"
  note "check: systemctl --user list-timers mnemosyne-daily.timer; systemctl --user status mnemosyne-daily.service"
fi

# ── 9. nothing deleted rows (counts only go up) ──────────────────────────────
# maintain.py records the counts after each run and fails the next run if any fell. This
# check does the same against the live store, so a deletion between runs still shows.
drop=$(python3 -c "
import json,sqlite3
try: prev=json.load(open('$STATE')).get('counts') or {}
except Exception: prev={}
db=sqlite3.connect('file:$DB?mode=ro',uri=True)
now={'user':db.execute(\"select count(*) from working_memory where content like '[USER] %'\").fetchone()[0],
     'episodic':db.execute('select count(*) from episodic_memory').fetchone()[0],
     'curated':db.execute(\"select count(*) from working_memory where metadata_json like '%migrated_from%'\").fetchone()[0]}
fell=[f'{k} {prev[k]}->{v}' for k,v in now.items() if k in prev and v<prev[k]]
print('|'.join(fell) if fell else 'none')
" 2>/dev/null)
if [ "$drop" = "none" ]; then ok "no row counts fell since the last maintenance run"; else bad "row counts FELL since the last run: ${drop//|/, }"; fi

# ── 10. no person's message is hidden from recall ────────────────────────────
# sleep's conflict step once hid three of the user's own messages. A short [USER] row
# that is superseded and is not a subagent prompt is exactly that failure.
hidden=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
console.log(db.prepare(\"select count(*) c from working_memory where superseded_by is not null and content like '[USER] %' and length(content)<300 and content not like '[USER] You are %' and content not like '[USER] Do not use%' and content not like '[USER] Use exactly%'\").get().c);
")
if [ "${hidden:-1}" = "0" ]; then ok "no short human [USER] message is hidden from recall"; else bad "${hidden} short human [USER] message(s) are hidden from recall (the conflict step again?)"; fi

# ── 11. summaries are being made while raw rows grow ─────────────────────────
# A run that quietly consolidates nothing looks healthy. If a month of captures exists
# and no summary has been written in 45 days, consolidation has stalled.
stall=$(q "
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('$DB',{readOnly:true});
const raw=db.prepare(\"select count(*) c from working_memory where (content like '[USER] %' or content like '[ASSISTANT] %') and datetime(timestamp)<datetime('now','-30 days')\").get().c;
const ep=db.prepare(\"select count(*) c from episodic_memory where datetime(created_at)>datetime('now','-45 days')\").get().c;
console.log(raw+'|'+ep);
")
raw_old=${stall%%|*}; ep_new=${stall##*|}
if [ "${raw_old:-0}" -gt 0 ] && [ "${ep_new:-0}" -eq 0 ]; then
  bad "$raw_old captures are over 30 days old and no summary was written in 45 days: consolidation has stalled"
else
  ok "consolidation is producing summaries (${ep_new} in the last 45 days; ${raw_old} captures older than 30 days)"
fi

# ── 12. the alert channel itself works ───────────────────────────────────────
# If the phone alert is broken, every other alarm is silent. The notify script leaves a
# marker file when a send fails.
if [ -f "$MNEMOSYNE_DATA_DIR/notify-failed.flag" ]; then
  bad "the last phone alert FAILED to send ($(cat "$MNEMOSYNE_DATA_DIR/notify-failed.flag")): other alarms may not reach you"
  note "test: ~/.dsh/bin/mnemosyne-notify.sh 'test' Memory   (token or 1Password reachability)"
else
  ok "the phone alert channel has no recorded failure"
fi

# ── cleanup ──────────────────────────────────────────────────────────────────
if [ -n "${probe_id:-}" ] && [ "$probe_id" != "None" ]; then
  del=$("$CLI" delete "$probe_id" 2>&1 | tail -1)
  case "$del" in
    *Deleted*) ok "probe removed again (store left as found, $del)" ;;
    *)         bad "could not remove the probe $probe_id: $del" ;;
  esac
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED ($pass)."
  echo "Writing and recalling both work. For the user-visible half of recall, look"
  echo "for the '## Mnemosyne Context' block at the top of a session's context:"
  echo "that block is the plugin injecting, and it is the only proof of injection."
  exit 0
else
  echo "$fail CHECK(S) FAILED, $pass passed. See the notes above."
  if [ "$UNATTENDED" -eq 1 ]; then
    /home/sil/.dsh/bin/mnemosyne-notify.sh "Memory health: $fail check(s) failed. Run: bash ~/.dsh/bin/mnemosyne-health.sh" "Memory"
  fi
  exit 1
fi
