#!/usr/bin/env bash
# Daily mnemosyne maintenance.
#   1. backup           a fresh restore point, always first
#   2. verify           integrity gate
#   3. maintain         mnemosyne-maintain.py: consolidate, check each summary, hide
#                       redundant [ASSISTANT] originals, compare counts. It never deletes.
#   4. prune backups    keep the newest 14
#
# Installed 2026-10-02 after a data-loss incident (TTL trim), a corruption, and a
# config-format mistake. Rewritten 2026-10-05: consolidation moved into
# mnemosyne-maintain.py, which carries the reasoning (read its docstring before changing
# anything). The earlier shell version deleted [ASSISTANT] originals; a review found that
# a partial summary can authorise that loss, so nothing is deleted any more.
#
# A failed run exits non-zero AFTER the backup and the prune, and the unit's OnFailure=
# sends a phone alert. The health script separately alarms if no run has succeeded in 36 h,
# because a timer that never starts cannot trigger OnFailure.
set -euo pipefail

# The daemon loads this same file: LLM settings, TTL, prompt. The engine reads them from
# the environment only, and a missing TTL means the 168 h default trim.
set -a
# shellcheck disable=SC1091
. /home/sil/.dsh/mnemosyne/llm.env
set +a
export MNEMOSYNE_DATA_DIR="${MNEMOSYNE_DATA_DIR:-/home/sil/.dsh/mnemosyne}"
export MNEMOSYNE_EMBEDDING_MODEL="${MNEMOSYNE_EMBEDDING_MODEL:-BAAI/bge-small-en-v1.5}"
export MNEMOSYNE_IMPORTANCE_WEIGHT="${MNEMOSYNE_IMPORTANCE_WEIGHT:-0}"
CLI=/home/sil/.local/bin/mnemosyne
PY=/home/sil/.local/share/uv/tools/mnemosyne-memory/bin/python
MAINTAIN=/home/sil/.dsh/bin/mnemosyne-maintain.py
BK=/home/sil/.dsh/backups
KEEP=14   # ~10 MB each, so this bounds the backup dir to roughly 140 MB
# systemd gives a unit only /usr/local/bin:/usr/bin. Every tool below is an absolute path
# for that reason: a bare `node` once exited 127 on the first live run.
[ -x "$PY" ] || { echo "python not found at $PY"; exit 1; }

echo "== mnemosyne backup =="
"$CLI" backup

echo "== mnemosyne verify =="
"$CLI" verify

echo "== maintain =="
# `|| rc=$?` keeps set -e from ending the script here: the prune below must still run.
rc=0
"$PY" "$MAINTAIN" || rc=$?

# Retention: only ever touches the compressed snapshots this job creates.
# The corrupt/post-incident .db files are left alone deliberately.
mapfile -t old < <(ls -1t "$BK"/mnemosyne_backup_*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if [ "${#old[@]}" -gt 0 ]; then
  echo "== pruning ${#old[@]} backup(s) beyond the newest $KEEP =="
  for f in "${old[@]}"; do echo "  rm $f"; rm -f "$f"; done
fi

echo "== done: $(ls -1 "$BK"/mnemosyne_backup_*.db.gz 2>/dev/null | wc -l) snapshots retained, maintain exit $rc =="

# Health runs AFTER maintain so its "last success" check sees this run's result. It sends
# its own phone alert when a check fails, so the failure is reported once even when the
# unit also fails. It checks things this script cannot: a timer that stopped, counts that
# fell between runs, a hidden human message, a stalled consolidation, a broken alert path.
hrc=0
/usr/bin/bash /home/sil/.dsh/bin/mnemosyne-health.sh --unattended || hrc=$?
echo "== health exit $hrc =="
[ "$rc" -ne 0 ] && exit "$rc"
exit "$hrc"
