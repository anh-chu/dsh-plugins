#!/usr/bin/env python3
"""Daily mnemosyne maintenance. Adds, hides and demotes. Never deletes a memory.

Why this exists. The engine's own sleep step is safe only when everything around it
works, and on this machine every failure so far was silent: a TTL trim that deleted
1,814 rows, an engine fallback that wrote keyword fragments, a conflict step that hid
a person's messages. So this script wraps sleep with the checks the engine lacks, and
refuses to destroy anything it cannot prove it kept.

Steps, in order (each failure is logged; the run exits non-zero and notifies):
  0. backup is taken by the caller (mnemosyne-daily.sh) before this runs
  1. router check        no model, no consolidation (the engine would write keywords)
  2. stamp agent notes   source=dsh rows are already distilled
  3. consolidate         per session, engine run with conflict handling and model
                         refresh turned off (see CONFLICT STEP and MODEL REFRESH)
  4. check each summary  deterministic rules; a bad summary is hidden, not kept in recall
  5. hide [ASSISTANT]    originals whose summary passed (valid_until, reversible)
  6. record counts       so the next run can tell if anything fell

Rejected summaries keep their source rows stamped. Un-stamping would hand the rows back
to the TTL trim (core/beam.py _trim_working_memory ignores `pinned`), which is how data
was lost before.

CONFLICT STEP. sleep() calls _detect_conflicts (cosine > 0.88, more than 1 h apart) and
invalidates the older row, which recall then hides. On conversation captures that hid
three of the user's own messages. We replace the detector with one that finds nothing.

MODEL REFRESH. sleep() also asks the model for 'canonical' profile facts and writes them
as ordinary recallable rows plus rows in canonical_facts/facts/memoria_facts. Nothing in
the plugin reads canonical_facts. agent_context='cron' switches it off (beam.py:8481),
and it must be set on every Mnemosyne object, including ones created per session.

Usage:  mnemosyne-maintain.py [--dry-run] [--db PATH] [--state PATH]
Exit:   0 clean, 1 something needs attention (details on stdout)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
DATA_DIR = os.environ.get("MNEMOSYNE_DATA_DIR", f"{HOME}/.dsh/mnemosyne")

# Thresholds. Each has a reason; change them here, not in the code below.
MIN_SUMMARY_CHARS = 120        # shorter than this is a stub, not a summary
MAX_UNSUPPORTED = 0.25         # share of identifiers in a summary absent from its sources
ASSISTANT_PREFIX = "[ASSISTANT] "


def say(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- checks
_ID_PATTERNS = [
    re.compile(r"`([^`\n]{2,80})`"),                       # backticked code/paths
    re.compile(r"(?:~|/)[\w.\-]+(?:/[\w.\-]+)+"),          # file paths
    re.compile(r"\b[A-Z]{2,6}-\d{1,5}\b"),                 # tickets: SEE-102
    re.compile(r"\b\d{3,}(?:\.\d+)?%?\b"),                 # numbers of 3+ digits
    re.compile(r"\b[0-9a-f]{7,40}\b"),                     # commit hashes
]


def identifiers(text: str) -> set[str]:
    found: set[str] = set()
    for pat in _ID_PATTERNS:
        for m in pat.finditer(text):
            tok = (m.group(1) if m.groups() else m.group(0)).strip().lower()
            if len(tok) >= 3:
                found.add(tok)
    return found


def is_aaak_shaped(text: str) -> bool:
    """The engine's keyword fallback looks like '[source] w1|w2|w3...' with few spaces."""
    head = text[:200]
    return head.startswith("[") and head.count("|") >= 6 and head.count(" ") < head.count("|")


def check_summary(summary: str, sources: list[str], source_ids: list[str], llm_used) -> list[str]:
    """Return the list of reasons this summary must not stay visible. Empty = accept.

    ponytail: this is a precision check on identifiers. It catches invented file names,
    tickets and numbers. It does NOT prove coverage; a summary can omit a decision and
    pass. A model judge was dropped on purpose: a pass would not make deleting sources
    safe, and a fail cannot undo what sleep already wrote.
    """
    why = []
    if llm_used is not True:
        why.append("summary was not written by the model (llm_used is not true)")
    if len(summary.strip()) < MIN_SUMMARY_CHARS:
        why.append(f"summary is only {len(summary.strip())} chars")
    if is_aaak_shaped(summary):
        why.append("summary has the shape of the keyword fallback")
    if not source_ids:
        why.append("summary lists no source rows")
    ids = identifiers(summary)
    if ids:
        blob = "\n".join(sources).lower()
        missing = sorted(i for i in ids if i not in blob)
        if len(missing) / len(ids) > MAX_UNSUPPORTED:
            why.append(
                f"{len(missing)} of {len(ids)} identifiers are not in the sources "
                f"(e.g. {', '.join(missing[:3])})"
            )
    return why


# ----------------------------------------------------------------------------- state
def load_state(path: str) -> dict:
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(path: str, state: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


def counts(db: sqlite3.Connection) -> dict:
    q = lambda sql, *a: db.execute(sql, a).fetchone()[0]
    return {
        "total": q("select count(*) from working_memory"),
        "user": q("select count(*) from working_memory where content like '[USER] %'"),
        "assistant": q("select count(*) from working_memory where content like '[ASSISTANT] %'"),
        "episodic": q("select count(*) from episodic_memory"),
        "curated": q("select count(*) from working_memory where metadata_json like '%migrated_from%'"),
    }


# ---------------------------------------------------------------------------- router
def router_ok(timeout: int = 60) -> bool:
    base = os.environ.get("MNEMOSYNE_LLM_BASE_URL", "").rstrip("/")
    model = os.environ.get("MNEMOSYNE_LLM_MODEL", "")
    if not base or not model or os.environ.get("MNEMOSYNE_LLM_ENABLED", "").lower() != "true":
        return False
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Reply with: OK"}],
                       "max_tokens": 8, "temperature": 0}).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {os.environ.get('MNEMOSYNE_LLM_API_KEY', '')}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return b'"choices"' in resp.read()
    except Exception:
        return False


# ------------------------------------------------------------------- topic segments
# The engine groups rows for one summary by `source` (beam.py: grouped.setdefault(row["source"]))
# and every captured turn has source 'conversation'. So one namespace gives ONE summary, and
# the 'default' namespace holds all home-directory work: that summary is a gist of a day.
# To get topic-sized summaries we ask the model to split the turns into topics and give each
# topic its own temporary `source` label for the length of one sleep. The label is restored
# afterwards. The engine only reads `source` as an optional recall filter, so nothing else
# depends on it. We do not patch the engine.
#
# Safety. A wrong split makes odd summaries, never data loss. Any invalid answer falls back to
# the old behaviour (one summary per session). A topic that straddles the age cutoff is split
# across two days' summaries.
SEGMENT_MIN_TURNS = 12     # fewer turns than this: one summary is fine
SEGMENT_MIN_SIZE = 3       # a topic shorter than this is folded into its neighbour
SEGMENT_WINDOW = 150       # turns per model call; a topic cut by a window edge is split in two
TOPIC_PREFIX = "conversation#"


def ask_model(prompt: str, max_tokens: int = 1800, timeout: int = 170) -> str | None:
    base = os.environ.get("MNEMOSYNE_LLM_BASE_URL", "").rstrip("/")
    body = json.dumps({"model": os.environ.get("MNEMOSYNE_LLM_MODEL", ""), "temperature": 0,
                       "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {os.environ.get('MNEMOSYNE_LLM_API_KEY', '')}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)["choices"][0]["message"]["content"]
    except Exception:
        return None


def parse_segments(text: str, n: int):
    """Return [[start, end, title], ...] covering turns 0..n-1 exactly once, in order, or None."""
    text = re.sub(r"^```(?:json)?|```$", "", (text or "").strip(), flags=re.M).strip()
    try:
        segs = json.loads(text)
    except Exception:
        return None
    if not isinstance(segs, list) or not segs:
        return None
    out, expect = [], 0
    for s in segs:
        try:
            a, b, t = int(s["start"]), int(s["end"]), str(s["title"])
        except Exception:
            return None
        if a != expect or b < a or b >= n:
            return None
        out.append([a, b, t])
        expect = b + 1
    return out if expect == n else None


def merge_small(segs):
    """Fold topics shorter than SEGMENT_MIN_SIZE into the previous one (the first into the next)."""
    out = []
    for a, b, t in segs:
        if out and (b - a + 1) < SEGMENT_MIN_SIZE:
            out[-1][1] = b
        else:
            out.append([a, b, t])
    if len(out) > 1 and (out[0][1] - out[0][0] + 1) < SEGMENT_MIN_SIZE:
        out[1][0] = out[0][0]
        out.pop(0)
    return out


def restore_sources(db) -> int:
    n = db.execute("update working_memory set source='conversation' where source like ?",
                   (TOPIC_PREFIX + "%",)).rowcount
    db.commit()
    return n


def tag_topics(db, sid: str, force: bool, cutoff: str, dry: bool) -> int:
    """Give each topic in this session's eligible turns its own temporary source label."""
    age = "" if force else "and datetime(timestamp) < datetime('now', ?)"
    rows = db.execute(
        "select id, timestamp, content from working_memory "
        "where coalesce(session_id,'default')=? and source='conversation' and consolidated_at is null "
        "and (pinned is null or pinned=0) " + age + " order by timestamp",
        (sid,) if force else (sid, cutoff)).fetchall()
    if len(rows) < SEGMENT_MIN_TURNS:
        return 0
    tagged, k = 0, 0
    for w0 in range(0, len(rows), SEGMENT_WINDOW):
        win = rows[w0:w0 + SEGMENT_WINDOW]
        lines = [f"{i}\t{r['timestamp'][5:16]}\t{r['content'].replace(chr(10), ' ')[:170]}" for i, r in enumerate(win)]
        prompt = (
            "Below are numbered conversation turns between a user and an AI coding agent, in time order. "
            "Lines starting [USER] are the user, [ASSISTANT] the agent. Split them into consecutive TOPIC "
            "segments: one segment is one task or subject (for example 'fix the OpenCode quirks plugin', "
            "'memory scoping', 'Agent Reach credentials'). Start a new segment only when the subject really "
            "changes. Do not split by time. A segment has at least 3 turns, except possibly the last. "
            "Answer with JSON only: a list of {\"start\": first turn number, \"end\": last turn number, "
            "\"title\": 3 to 8 words}. Segments must cover every turn exactly once, in order.\n\n" + "\n".join(lines))
        segs = parse_segments(ask_model(prompt), len(win))
        if segs is None:
            say(f"      topic split INVALID for {sid[-12:]} turns {w0}-{w0 + len(win) - 1}; "
                "falling back to one summary for them")
            continue
        segs = merge_small(segs)
        if len(segs) == 1:
            continue
        for a, b, title in segs:
            k += 1
            slug = re.sub(r"[^A-Za-z0-9 ]+", " ", title).strip()[:60] or "topic"
            label = f"{TOPIC_PREFIX}{k} {slug}"
            ids = [r["id"] for r in win[a:b + 1]]
            if not dry:
                db.execute(f"update working_memory set source=? where id in ({','.join('?' * len(ids))})",
                           (label, *ids))
            say(f"      topic {k}: {len(ids):3d} turns  {slug}")
            tagged += len(ids)
        if not dry:
            db.commit()
    return tagged


# ------------------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    # --force consolidates every unconsolidated row now, whatever its age. It exists to run
    # the full production path on demand. Do NOT shorten MNEMOSYNE_WM_TTL_HOURS for this: the
    # trim reads it on every write and deletes unconsolidated rows older than it.
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-topics", action="store_true",
                    help="one summary per session, as before (the fallback behaviour)")
    ap.add_argument("--db", default=f"{DATA_DIR}/mnemosyne.db")
    ap.add_argument("--state", default=f"{DATA_DIR}/maintain-state.json")
    args = ap.parse_args()

    problems: list[str] = []
    db = sqlite3.connect(args.db, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("pragma busy_timeout = 15000")
    state = load_state(args.state)
    before = counts(db)
    say(f"== counts before: {before}")

    # Falling counts mean something deleted rows. Nothing in this script deletes.
    prev = state.get("counts")
    if prev:
        for key in ("user", "episodic", "curated", "total"):
            if before[key] < prev.get(key, 0):
                problems.append(f"{key} count FELL since the last run: {prev[key]} -> {before[key]}")

    if not router_ok():
        problems.append("router did not answer, or the summariser is not enabled; consolidation skipped")
        say("== router check FAILED; consolidation skipped")
        return finish(db, args, state, before, problems)
    say("== router answered")

    # The engine is imported only now, after the environment is final.
    from mnemosyne.core import beam as beam_mod
    from mnemosyne.core.memory import Mnemosyne

    # CONFLICT STEP off: see module docstring.
    beam_mod.BeamMemory._detect_conflicts = lambda self, rows, similarity_threshold=0.88: []

    # Step 2: agent notes are already distilled.
    if not args.dry_run:
        n = db.execute("update working_memory set consolidated_at=? where source='dsh' and consolidated_at is null",
                       (datetime.now().isoformat(),)).rowcount
        db.commit()
        say(f"== stamped {n} agent note(s)")

    ttl = float(os.environ.get("MNEMOSYNE_WM_TTL_HOURS", "168"))
    cutoff = f"-{ttl / 2} hours"
    age_clause = "" if args.force else "and datetime(timestamp) < datetime('now', ?)"
    sessions = [r[0] for r in db.execute(
        "select distinct coalesce(session_id,'default') from working_memory "
        "where consolidated_at is null and (pinned is null or pinned=0) " + age_clause,
        () if args.force else (cutoff,))]
    say(f"== {len(sessions)} session(s) with " +
        ("unconsolidated rows (FORCED, any age)" if args.force else f"rows older than {ttl / 2:.0f} h"))

    # A previous run that died between tagging and restoring leaves rows labelled
    # 'conversation#...'. Undo that first, so the labels never outlive one run.
    if not args.dry_run:
        left = restore_sources(db)
        if left:
            say(f"== restored {left} leftover topic label(s) from an interrupted run")

    summaries_written = 0
    for sid in sessions:
        mem = Mnemosyne(session_id=sid, bank=os.environ.get("MNEMOSYNE_BANK") or None)
        mem.beam.agent_context = "cron"          # MODEL REFRESH off, on THIS object
        mark = db.execute("select coalesce(max(rowid),0) from episodic_memory").fetchone()[0]
        try:
            # TOPIC SEGMENTS: label each topic so the engine writes one summary per topic.
            # The label is restored in the finally below, even if sleep raises.
            if not args.no_topics:
                tag_topics(db, sid, args.force, cutoff, args.dry_run)
            res = mem.sleep(dry_run=args.dry_run, force=args.force)
        except Exception as exc:                 # noqa: BLE001
            problems.append(f"{sid}: sleep raised {exc!r}")
            continue
        finally:
            if not args.dry_run:
                restore_sources(db)
        status = res.get("status")
        method = res.get("method")
        say(f"   {sid[-24:]}: {status} items={res.get('items_consolidated')} method={method}")
        if status == "no_op" or args.dry_run:
            continue
        if method != "llm":
            problems.append(f"{sid}: method was {method!r}, not 'llm' (keyword fallback in the mix)")
        if res.get("errors"):
            problems.append(f"{sid}: engine reported errors {res['errors']}")

        # Step 4: check every summary this call wrote.
        rows = db.execute(
            "select rowid, id, content, summary_of, metadata_json from episodic_memory where rowid > ?",
            (mark,)).fetchall()
        for ep in rows:
            ids = [x for x in (ep["summary_of"] or "").split(",") if x]
            srcs = [r[0] for r in db.execute(
                f"select content from working_memory where id in ({','.join('?' * len(ids))})", ids)] if ids else []
            try:
                llm_used = json.loads(ep["metadata_json"] or "{}").get("llm_used")
            except Exception:
                llm_used = None
            why = check_summary(ep["content"], srcs, ids, llm_used)
            if why:
                # Hide the summary; the rows stay stamped so the trim cannot reach them.
                db.execute("update episodic_memory set valid_until=? where id=?",
                           (datetime.now().isoformat(), ep["id"]))
                db.commit()
                problems.append(f"{sid}: summary {ep['id']} hidden: {'; '.join(why)}")
                continue
            summaries_written += 1
            # The engine gives a summary the EARLIEST valid_until among the rows it covers
            # (beam.py ~8372). Once an [ASSISTANT] original is hidden, a later consolidation
            # of a group that includes it writes a summary that is born expired and so is
            # invisible to recall. A summary that passed our checks must be visible, so clear
            # any inherited expiry. (Found on the first live topic run: 8 of 13 summaries
            # were born hidden.)
            db.execute("update episodic_memory set valid_until=NULL where id=? and valid_until is not null",
                       (ep["id"],))
            # Step 5: the summary passed, so its [ASSISTANT] originals are redundant noise.
            # Hide with invalidate() (valid_until + superseded_by); recall already respects it.
            hid = 0
            for wid in ids:
                row = db.execute("select content from working_memory where id=?", (wid,)).fetchone()
                if row and row[0].startswith(ASSISTANT_PREFIX):
                    db.execute("update working_memory set valid_until=?, superseded_by=? where id=?",
                               (datetime.now().isoformat(), ep["id"], wid))
                    hid += 1
            db.commit()
            if hid:
                say(f"      hid {hid} [ASSISTANT] original(s) behind summary {ep['id']}")

    say(f"== summaries accepted this run: {summaries_written}")
    return finish(db, args, state, before, problems)


def finish(db, args, state, before, problems) -> int:
    after = counts(db)
    # A hidden human message is the failure that started this: report any.
    hidden_human = db.execute(
        "select count(*) from working_memory where superseded_by is not null "
        "and content like '[USER] %' and length(content) < 300 "
        "and content not like '[USER] You are %' and content not like '[USER] Do not use%' "
        "and content not like '[USER] Use exactly%'").fetchone()[0]
    if hidden_human:
        problems.append(f"{hidden_human} short human [USER] message(s) are hidden from recall")
    for key in ("user", "episodic", "curated"):
        if after[key] < before[key]:
            problems.append(f"{key} count fell DURING this run: {before[key]} -> {after[key]}")

    if not args.dry_run:
        state["counts"] = after
        state["last_run"] = datetime.now(timezone.utc).isoformat()
        state["last_ok"] = None if problems else state["last_run"]
        if not problems:
            state["last_success"] = state["last_run"]
        save_state(args.state, state)

    say(f"== counts after: {after}")
    if problems:
        say("== NEEDS ATTENTION:")
        for p in problems:
            say(f"   - {p}")
        return 1
    say("== clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
