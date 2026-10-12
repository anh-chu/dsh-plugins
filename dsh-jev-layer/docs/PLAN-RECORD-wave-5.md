# Plan record: dsh-jev-layer, wave 5

Written after the waves closed, when the last tickets were settled. Not a source
of truth: `SPEC.md`, `TICKETS.md` and `docs/CONTRACT.md` are.

## What this wave was for

Three things the wave-by-wave work left open: nothing proved the plugin's own
wiring end to end, the ledger vanished with the process, and two modules declared
seams they never listened on. `guide.shared` was reopened here as well.

## What shipped

- `scripts/gate-t26-e2e.mjs` — the wiring gate.
- `ledgerPath`, a setting that appends every judgment to a JSONL file.
- `seam: null`, a descriptor that consumes no harness event.
- `guide.shared`, the module this wave originally closed.

## Decisions and why

- **The wiring gate drives the real registry, the real shipped module list and the
  real core, with only the judge transport stubbed.** Every module gate drives a
  synthetic `api`, which is what let several agents work in parallel and also what
  hid a credential that never resolved. A gate that never touches the real chain
  cannot see a broken chain.
- **The ledger is a file when you ask for one.** Shadow mode's promise is to record
  what it would have done so you can read it later; an in-memory ledger made the
  second half impossible. Empty by default, because a personal plugin should not
  write files nobody asked for.
- **`seam: null` says what is true.** The nag and the decline notifier hear the
  autopilot's decision on the core's own channel. Naming a harness seam they never
  listened on bought two listeners that could never fire.
- **`guide.shared` reads its recipient map from its own log.** `send_message` takes
  an `agent_id` and the call is recorded in the sender's session, so the map needs
  no cross-session store.

## The two mistakes this wave is named for

1. **A gate that cannot exercise its own path is a gate that lies.** `gate-t26-e2e`
   failed its first run because its fixture joined segments with a single newline
   while the module chunks on blank lines: the payload was one chunk and could
   never be pruned. It looked like the plugin was broken; the test was.
2. **An empty search is not a finding.** `guide.shared` was closed as out of scope
   because no package produced the `relay` context form. That was verified and
   true. The conclusion drawn from it — that nothing records who was told what —
   was false: the record was in the sender's own session the whole time. The rule
   is now in memory: enumerate every side of the flow, and say which sides were
   actually checked.

## Debt

- Parity with the plugin this replaces remains stub-level: identical decisions
  given identical judge answers, not a live side-by-side.
- `packages/plugin/package.json` names the core through an absolute `file:` path,
  which is what makes a `file:` install work and what blocks publishing.
