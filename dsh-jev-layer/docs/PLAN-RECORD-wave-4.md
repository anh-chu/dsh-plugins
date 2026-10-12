# Plan record: dsh-jev-layer, wave 4

Written when wave 4's tickets closed. Not a source of truth: `SPEC.md`,
`TICKETS.md` and `docs/CONTRACT.md` are.

## What this wave was for

The large or risky capabilities: reducing the tool surface, steering the next
read, queueing a correction, and answering an escalation. Every one of them
touches something shared, which is why they came last.

## What shipped

Five modules: `tools.surface`, `rank.files`, `route.interjection`,
`approve.workspace` and — reopened and delivered in the same wave, after the
section below was written — `guide.shared`.

## Decisions and why

- **`tools.surface` is off by default and changes the set at most once per
  session.** Every change rewrites the tool schemas inside the prompt prefix, so
  each change is a cache invalidation. That is the same trade `dsh-jev-router`
  ships its model switching disabled for, and the reason this module is last.
- **`rank.files` never transforms a result.** `admit.output` owns `glob` output on
  `tools/post-execute`; a second transformer on one result would be a second judge
  on it. So `rank.files` observes on `tools/result` and reports.
- **`route.interjection` queues and does not rewrite.** `agent/pre-step` is a
  broadcast seam shared with five other observers, so it returns the decision
  deep-equal. When that constraint turned out to block real delivery, the ticket
  said to report rather than take the decision silently, and it did.
- **`approve.workspace` returns `ask`, and passes through on a failing judge.**
  A guard that cannot decide must not allow, so the failure path is the harness's
  own human approval, not an implicit yes.
- **`guide.shared` was closed here, then reopened.** See the wave 5 record: it was
  closed on a claim that turned out to be false, and the correction is kept in
  `SPEC.md` and `TICKETS.md` rather than deleted.

## Deliberately excluded

- Any rewrite of the pre-step decision by a wave 4 module.
- Pausing a stalled goal. The wave 2 supervision module raises a notice only;
  pausing changes the agent loop and needs its own decision.

## Debt and lessons

- **Four places enumerate the shipped modules** and this wave needed all four
  updated: the `SHIPPED` array and owners map in `gate-modules.mjs`, the
  `EXPECTED` map and its per-seam count assertions in `gate-t21-seamclass.mjs`,
  and the id list in `gate-live.mjs`. Every wave discovered this the hard way; it
  is now written down.
- Two modules ended up declaring seams that were not harness events, which wave 5
  fixed by allowing `seam: null`.
