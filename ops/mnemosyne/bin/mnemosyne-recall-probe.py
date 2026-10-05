#!/usr/bin/env python3
"""Monthly recall check: does the memory still find what it should?

Runs the 29 probe questions against the live store and compares the hit rate at 5 with a
recorded baseline. This replaces a human re-reading summaries. It is the only quality
signal the system has that does not depend on the model that writes the summaries.

How it scores. Each probe has one target memory. Since routing, a target can live in the
shared pool or in a project namespace, and a session only reads its own namespace plus the
shared pool. So each probe is asked from the namespace that OWNS its target, which is how a
real session in that project would ask it. (A plain CLI run asks from the default namespace
and cannot see project rows, so it under-reports: 20.7% against 58.6% on the same store.)

Alarm rule. The baseline is 17 of 29 hits at 5 (58.6%) measured 2026-10-05. A 29-probe set
moves by about two probes between identical runs, so the alarm is baseline minus 3.

ponytail: 29 probes is a coarse instrument. It will not see a 5-point drift; it will see
a collapse. Upgrade path: add probes drawn from the summaries themselves once a few
months of them exist.

Usage:  mnemosyne-recall-probe.py [--set-baseline] [--db PATH]
Exit:   0 within the noise band, 1 regression
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("MNEMOSYNE_DATA_DIR", f"{HOME}/.dsh/mnemosyne")
PROBES = f"{DATA_DIR}/recall-probes.json"
BASELINE = f"{DATA_DIR}/recall-baseline.json"
HISTORY = f"{DATA_DIR}/recall-history.jsonl"
NOISE = 3          # probes; see the docstring


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set-baseline", action="store_true")
    ap.add_argument("--db", default=f"{DATA_DIR}/mnemosyne.db")
    args = ap.parse_args()

    probes = json.load(open(PROBES))["positive"]
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    from mnemosyne.core.memory import Mnemosyne

    scored = hits5 = hits1 = 0
    per = []
    for p in probes:
        row = db.execute("select session_id, scope from working_memory where id=?", (p["id"],)).fetchone()
        if not row:
            per.append({"id": p["id"], "status": "target missing"})
            continue
        # A row in the shared pool is asked from 'default'; a project row from its namespace.
        owner = "default" if (row[0] == "default" and row[1] == "global") else row[0]
        mem = Mnemosyne(session_id=owner, bank=os.environ.get("MNEMOSYNE_BANK") or None)
        res = mem.beam.recall(p["probe"], top_k=5, _cross_session=False)
        ids = [r.get("id") for r in res]
        rank = ids.index(p["id"]) + 1 if p["id"] in ids else None
        scored += 1
        hits5 += rank is not None
        hits1 += rank == 1
        per.append({"id": p["id"], "owner": owner[:26], "rank": rank})

    now = datetime.now(timezone.utc).isoformat()
    result = {"at": now, "scored": scored, "hits_at_5": hits5, "hits_at_1": hits1,
              "pct_at_5": round(100 * hits5 / scored, 1) if scored else 0.0}
    print(f"recall probes: {hits5}/{scored} at 5 ({result['pct_at_5']}%), {hits1}/{scored} at 1")

    if args.set_baseline:
        json.dump(result, open(BASELINE, "w"), indent=2)
        print(f"baseline recorded: {BASELINE}")
        return 0

    with open(HISTORY, "a") as fh:
        fh.write(json.dumps(result) + "\n")
    try:
        base = json.load(open(BASELINE))
    except Exception:
        print("no baseline recorded; run with --set-baseline first")
        return 1
    floor = base["hits_at_5"] - NOISE
    print(f"baseline {base['hits_at_5']}/{base['scored']} at 5 ({base['at'][:10]}); alarm at {floor} or fewer")
    if hits5 <= floor:
        misses = [x["id"][:8] for x in per if x.get("rank") is None and x.get("status") != "target missing"]
        print(f"REGRESSION: {hits5} hits at 5, baseline {base['hits_at_5']}. Missed: {', '.join(misses[:12])}")
        return 1
    print("within the noise band")
    return 0


if __name__ == "__main__":
    sys.exit(main())
