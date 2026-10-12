# Plan record: dsh-jev-layer, wave 2

Written when wave 2's tickets closed. Not a source of truth: `SPEC.md`,
`TICKETS.md` and `docs/CONTRACT.md` are.

## What this wave was for

Wave 1 reached parity with the installed `dsh-jev-tools`. Wave 2 adds the
capabilities that plugin does not have: log admission for terminal output, and
three observers on the agent lifecycle. It also had to answer a design question
wave 1 deferred — how two modules can act on one harness event.

## What shipped

Four modules behind the existing registry, all off on a fresh install:
`admit.terminal` (bash and pwsh log admission), `supervise.goal`, `remind.drift`
and `guide.instructions`. Plus `T21`, the seam-class change they depend on.

## Decisions and why

- **Exclusive seams partition by `targets`, rather than allowing one owner.**
  `admit.output` and `admit.terminal` both transform `tools/post-execute` with
  genuinely disjoint targets: read, grep, glob and the web tools versus bash and
  pwsh. Plain exclusivity forbade that and a second seam for the same event does
  not exist. Owners now declare their targets; an intersection is a startup error
  naming both, disjoint sets coexist, and an owner returns the event unchanged for
  a target it does not own.
- **`agent/pre-step` is a broadcast seam.** `select.skill` already owned it, and
  three wave 2 modules need to observe the same event. Broadcast owners may not
  rewrite the decision; the registry dispatches to all of them in registration
  order and then calls the harness continuation. `route.interjection` rewrites,
  so it is explicitly excluded from this seam and stays in wave 4 with a
  queue-only re-scope or a seam of its own.
- **Observers return the same event reference or `undefined`.** The registry warns
  on any other return, because a silently ignored rewrite is worse than a warning.
- **Module gates drive a synthetic `api`.** Same reason as wave 1: it keeps the
  modules independent of the core. The counterweight is the live gate added in
  wave 1, which is what catches host-wiring failures the synthetic gates cannot
  see.

## Deliberately excluded

- Pausing a stalled goal. The ticket asked for an advisory notice only; pausing is
  a behaviour change to the agent loop and would need its own decision.
- Any rewrite of the pre-step decision by a wave 2 module.

## Debt and lessons

- `packages/plugin/package.json` still names the core through an absolute `file:`
  path, so publishing remains blocked.
- The install protocol changed from `file:` to `link:`. A `file:` install
  hard-links existing files but does not carry new ones, so adding a module would
  have left the installed barrel importing a file that was not there, and the next
  host start would have failed. `link:` symlinks the package and was verified to
  propagate a new file immediately. The cost is that mid-edit code is live at the
  next restart, so each wave must end green.
- A live-profile disturbance is recorded in `TICKETS.md`: `dsh-jev-router`
  disappeared from the `web` profile during the build and was restored. It was
  found by diffing the profile, not by any agent report. Future prompts state
  explicitly that no agent may run a profile command against `web`.
