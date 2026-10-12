# Plan record: dsh-jev-layer, wave 3

Written when wave 3's tickets closed. Not a source of truth: `SPEC.md`,
`TICKETS.md` and `docs/CONTRACT.md` are.

## What this wave was for

Wave 3 is the operator's own first use case: stop having to answer the agent's
own questions. `answer.questions` decides an answerable batch, `notify.decline`
tells the operator when it could not, and `nag.nogoal` tells whoever can act that
the session has no goal, which is why nobody was coming to press the button.

## What shipped

Three modules and one core channel: `core/src/events.js`, exposed to modules as
`api.events`, plus `answer.questions`, `nag.nogoal` and `notify.decline`. Every
one is off on a fresh install and `answer.questions` defaults to shadow.

## Decisions and why

- **The nag does not observe `user-questions/request`.** `answer.questions` owns
  that seam exclusively, so a nag that watched it would be a second owner. It
  consumes `question/evaluated` on the core's own channel instead, which carries
  the decision at the moment it is made. This is the conflict identified two
  waves earlier, and T25 is the interface that resolved it.
- **The channel is in-process and holds no state.** The session log stays the only
  source of truth, so a subscriber that misses an event can read the same fact
  from the ledger. A subscriber that throws is logged and skipped: the publisher
  is in the middle of a decision.
- **The core owns the URL transport, the module owns the command transport.** The
  defect this wave found was exactly that line being blurred by a setting the
  module never declared.
- **The autonomy gate is `phase === 'active'` and `activation === 'armed'`,**
  verified against the installed goal types. `disarmed` means a human is expected,
  so the question goes to them. A goal that is paused, blocked or disarmed is a
  deliberate state and does not nag.

## Deliberately excluded

- Answering anything the gates do not fully cover. A partial batch is never sent,
  because the answer must name each question of the call exactly once.
- Enabling the goal tool. Recorded here as the operator's decision, which was
  **wrong**: the web bundle disables its `tool-goal` row because presets own the
  model-facing tool, and the active `standard-jev` preset declares it. The
  agent-facing nag is therefore live, not inert. See the correction in `SPEC.md`.

## Debt

- No version control in this repository. Repairing a broken edit meant reading
  regions and re-checking, with nothing to compare against. This is the first
  thing to fix before wave 4.
- `nag.nogoal` and `notify.decline` declare seams that are not harness events,
  because a descriptor must name one. The registry registers a listener that never
  fires. Harmless, wrong shape.
