# Tickets: dsh-jev-layer, wave 1

Spec: `SPEC.md` in this directory. Wave 1 is the core plus parity with the
installed `dsh-jev-tools`, so that it can be uninstalled afterwards.

Implementation language is plain ESM JavaScript with `node --test`. No build
step, no TypeScript, no runtime dependencies. `node --check` and `node --test`
are the whole toolchain. This is deliberate: the core must be testable with no
host, and a build step would add a failure mode to every ticket.

Every gate is a `scripts/gate-*.mjs` assert script that exercises the real
artifact and prints one unique marker after all its assertions pass. `node --test`
suites are development checks; gates are the acceptance record.

## Coverage inventory

| CID | Required outcome | Owner | Observed by |
|---|---|---|---|
| CID-1 | Fresh install has every module off, and composes on 0.2.0-rc.2 | T1 | G-T1-1 |
| CID-2 | `engines.dsh` is a real range; no `@deepseek-ai/dsh*` peer is `*` | T1 | G-T1-2 |
| CID-3 | A module that throws on start does not fail the loader entry | T5 | G-T5-1 |
| CID-4 | Toggling a module at runtime takes effect without a restart | T5 | G-T5-2 |
| CID-5 | Disabling a module disposes its per-agent registrations | T5 | G-T5-3 |
| CID-6 | Two enabled modules on one seam is a startup error naming both ids | T5 | G-T5-4 |
| CID-7 | Shadow mode records the decision and acts on nothing | T3, T6, T7, T8, T9 | G-T3-3 |
| CID-8 | With the ceiling exhausted, answering keeps its sub-budget | T3 | G-T3-2 |
| CID-9 | Two notice requests in one turn produce one notice, loser recorded | T4 | G-T4-1 |
| CID-10 | The ledger rebuilds from the session log with the same decisions | T3 | G-T3-4 |
| CID-11 | Answers only when every answer gate holds (wave 3) | T13 | - |
| CID-12 | At most one notification, failed send does not change the outcome (wave 3) | T14 | - |
| CID-13 | Tool set changes at most once per session; disposer restores (wave 4) | T15 | - |
| CID-14 | With wave 1 on, the same result, skill and verdict as `dsh-jev-tools` | T12 | G-T12-1 |
| CID-15 | Uninstalling leaves no per-agent handlers registered | T11 | G-T11-4 |
| CID-16 | Nag inert, with a composition warning, when its trigger module is off (wave 3) | T13 | - |
| CID-17 | An enabled module acts on the judge in a live host: the credential named by `apiKeyRef` resolves from the DSH credential store, and one real judgment returns a probability. Mounting, activating and toggling are not evidence of this | T11 | G-T11-5 |

---

## T1 — Workspace skeleton and frozen contract

Blockers: none.

Behaviour: the repo exists as a pnpm workspace with `packages/core` and
`packages/plugin`. The plugin declares `dsh.bundle.patch`, mounts as one row, and
exposes the module registry, the config schema with one volatile boolean per
module id, and the frozen core interface that every later ticket codes against.
The module list is empty except for a registry that knows how to be empty.

## Gates

- [x] G-T1-1: the profile composes with the plugin row present and zero skipped bundles
  CHECK: `node scripts/gate-t1-compose.mjs`
  EXPECT: `GATE-T1-COMPOSE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T1-COMPOSE-OK` via `node scripts/gate-t1-compose.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T1-2: no gated DSH peer range is a wildcard and `engines.dsh` is a real range
  CHECK: `node scripts/gate-t1-manifest.mjs`
  EXPECT: `GATE-T1-MANIFEST-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T1-MANIFEST-OK` via `node scripts/gate-t1-manifest.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T2 — Judge client and shared limiter

Blockers: T1.

Behaviour: `core/judge.js` exposes `ask(state, questions, options)`. Endpoint,
model and timeout come from settings, never a constant. Credentials resolve
through the DSH credential seam. The call never throws: every failure returns
`null` and sets a typed `lastError`. One shared limiter serializes calls with
429/529 backoff and honours `Retry-After`.

## Gates

- [x] G-T2-1: the client requests the configured endpoint and returns null on every failure path without throwing
  CHECK: `node scripts/gate-t2-client.mjs`
  EXPECT: `GATE-T2-CLIENT-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T2-CLIENT-OK` via `node scripts/gate-t2-client.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T3 — Budget, ledger, shadow

Blockers: T1.

Behaviour: one per-turn ceiling with per-feature sub-budgets; explicit priority
so the answering feature outranks pruning. The ledger appends records keyed by
feature id holding the question, probabilities, threshold, decision and the
would-be outcome in shadow mode, and can be rebuilt from the session log.

## Gates

- [x] G-T3-1: the ledger records a decision with its probabilities and threshold
  CHECK: `node scripts/gate-t3-ledger.mjs`
  EXPECT: `GATE-T3-LEDGER-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T3-LEDGER-OK` via `node scripts/gate-t3-ledger.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T3-2: with the ceiling exhausted, the answering feature still gets its sub-budget and a pruning feature starves
  CHECK: `node scripts/gate-t3-priority.mjs`
  EXPECT: `GATE-T3-PRIORITY-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T3-PRIORITY-OK` via `node scripts/gate-t3-priority.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T3-3: in shadow the ledger holds the would-be decision and no action is taken
  CHECK: `node scripts/gate-t3-shadow.mjs`
  EXPECT: `GATE-T3-SHADOW-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T3-SHADOW-OK` via `node scripts/gate-t3-shadow.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T3-4: deleting the ledger and rebuilding from the log yields the same decisions
  CHECK: `node scripts/gate-t3-rebuild.mjs`
  EXPECT: `GATE-T3-REBUILD-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T3-REBUILD-OK` via `node scripts/gate-t3-rebuild.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T4 — Notice arbiter

Blockers: T1.

Behaviour: at most one notice per turn and a per-session cap; blocked-state
notices outrank advisory ones; dedupe by content hash; a summary is never
repeated within a session; a suppressed notice is recorded, not dropped.

## Gates

- [x] G-T4-1: two requests in one turn produce exactly one notice and the loser is recorded
  CHECK: `node scripts/gate-t4-arbiter.mjs`
  EXPECT: `GATE-T4-ARBITER-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T4-ARBITER-OK` via `node scripts/gate-t4-arbiter.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T5 — Registry lifecycle

Blockers: T1.

Behaviour: modules start lazily inside their own `try/catch` after `apply()`
returns; a module that throws is marked off and the rest still start. Each module
owns and disposes its own per-agent registrations. Two enabled modules claiming
one seam fails the composition with both ids named.

## Gates

- [x] G-T5-1: a throwing module leaves the entry active and the others started
  CHECK: `node scripts/gate-t5-isolation.mjs`
  EXPECT: `GATE-T5-ISOLATION-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T5-ISOLATION-OK` via `node scripts/gate-t5-isolation.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T5-2: a runtime toggle changes the active set without a restart
  CHECK: `node scripts/gate-t5-toggle.mjs`
  EXPECT: `GATE-T5-TOGGLE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T5-TOGGLE-OK` via `node scripts/gate-t5-toggle.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T5-3: disabling a module runs its per-agent disposer
  CHECK: `node scripts/gate-t5-disposal.mjs`
  EXPECT: `GATE-T5-DISPOSAL-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T5-DISPOSAL-OK` via `node scripts/gate-t5-disposal.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T5-4: two enabled modules on one seam fail startup and both ids are named
  CHECK: `node scripts/gate-t5-seam.mjs`
  EXPECT: `GATE-T5-SEAM-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T5-SEAM-OK` via `node scripts/gate-t5-seam.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T6 — admit.output

Blockers: T2, T3, T4, T5.

Behaviour: results of `read`, `grep`, `glob`, `web_fetch`, `web_search` above
2000 tokens keep the task-relevant segments, scattered rather than one contiguous
cut, judged through the core. On any judge failure everything is kept.

## Gates

- [x] G-T6-1: a fixture result keeps the segments the task needs and drops the ones it does not
  CHECK: `node scripts/gate-t6-admit.mjs`
  EXPECT: `GATE-T6-ADMIT-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T6-ADMIT-OK` via `node scripts/gate-t6-admit.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T6-2: with the judge unavailable the result is unchanged
  CHECK: `node scripts/gate-t6-failopen.mjs`
  EXPECT: `GATE-T6-FAILOPEN-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T6-FAILOPEN-OK` via `node scripts/gate-t6-failopen.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T7 — screen.fetch

Blockers: T2, T3, T4, T5.

Behaviour: fetched page text is judged for instructions aimed at the model; above
the threshold one notice is delivered through the arbiter, naming the source.

## Gates

- [x] G-T7-1: a page carrying a model-directed instruction raises exactly one notice; a clean page raises none
  CHECK: `node scripts/gate-t7-screen.mjs`
  EXPECT: `GATE-T7-SCREEN-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T7-SCREEN-OK` via `node scripts/gate-t7-screen.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T8 — select.skill

Blockers: T2, T3, T4, T5.

Behaviour: with a catalog of 15 or more, at most one skill is selected per turn
from the latest user message, falling back to the last three when it is too
short. Below 15 skills, nothing is selected. This is the single skill-selection
implementation; nothing else in the plugin may also pick a skill.

## Gates

- [x] G-T8-1: a large catalog yields exactly one skill, a small catalog yields none
  CHECK: `node scripts/gate-t8-skill.mjs`
  EXPECT: `GATE-T8-SKILL-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T8-SKILL-OK` via `node scripts/gate-t8-skill.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T9 — gate.completion

Blockers: T2, T3, T4, T5.

Behaviour: `jev_gate` accepts a request, claims, evidence and artifact, and
returns a per-claim verdict; a claim without supporting evidence is not accepted.
An automatic variant checks the visible final answer against recorded evidence
and may request at most one supplemental attempt.

## Gates

- [x] G-T9-1: an unsupported claim is rejected and a supported one is accepted
  CHECK: `node scripts/gate-t9-completion.mjs`
  EXPECT: `GATE-T9-COMPLETION-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T9-COMPLETION-OK` via `node scripts/gate-t9-completion.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T10 — tools.ask

Blockers: T2, T3.

Behaviour: `jev_ask` exposes typed `noul`, `choice` and `score` questions and
returns probabilities per question id. With no credential configured it reports
unconfigured and does not throw.

## Gates

- [x] G-T10-1: typed questions return one probability per question id, and an unconfigured judge reports rather than throws
  CHECK: `node scripts/gate-t10-ask.mjs`
  EXPECT: `GATE-T10-ASK-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T10-ASK-OK` via `node scripts/gate-t10-ask.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T11 — Install and live verification in a throwaway profile

Blockers: T6, T7, T8, T9, T10.

Behaviour: the plugin installs into a throwaway profile from a `file:` path,
composes, activates, exposes its settings, toggles at runtime, and uninstalls
leaving no handlers.

## Gates

- [x] G-T11-1: the throwaway profile reports the plugin entry active
  CHECK: `node scripts/gate-live.mjs --check active`
  EXPECT: `GATE-LIVE-ACTIVE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-LIVE-ACTIVE-OK` via `node scripts/gate-live.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T11-2: a runtime toggle through the settings route changes the active set
  CHECK: `node scripts/gate-live.mjs --check toggle`
  EXPECT: `GATE-LIVE-TOGGLE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-LIVE-TOGGLE-OK` via `node scripts/gate-live.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T11-3: module states and the ledger are readable from the plugin's status route
  CHECK: `node scripts/gate-live.mjs --check status`
  EXPECT: `GATE-LIVE-STATUS-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-LIVE-STATUS-OK` via `node scripts/gate-live.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T11-4: after removal no handler remains for a disposed agent
  CHECK: `node scripts/gate-live.mjs --check uninstall`
  EXPECT: `GATE-LIVE-UNINSTALL-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-LIVE-UNINSTALL-OK` via `node scripts/gate-live.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T11-5: in a live throwaway profile the judge is configured and one real judgment returns a probability, with a positive control proving the same probe reports unconfigured when the credential is absent
  CHECK: `node scripts/gate-live.mjs --check judge`
  EXPECT: `GATE-LIVE-JUDGE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-LIVE-JUDGE-OK` via `node scripts/gate-live.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## T12 — Parity with dsh-jev-tools

Blockers: T11.

Behaviour: for a recorded session, wave 1 produces the same tool-result
retention decision, the same skill suggestion and the same completion verdict as
the installed `dsh-jev-tools` 0.1.13. Only then is removing `dsh-jev-tools` a
decision the operator can take.

## Gates

- [x] G-T12-1: a recorded fixture yields the same retention, skill and completion outcome as the baseline
  CHECK: `node scripts/gate-t12-parity.mjs`
  EXPECT: `GATE-T12-PARITY-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T12-PARITY-OK` via `node scripts/gate-t12-parity.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

---

## Later waves, not started

T13 start `answer.questions` in shadow, with its gates and the answer contract.
T14 `notify.decline` with rate limiting. T15 `nag.nogoal` on the internal
`question/evaluated` event, plus criterion 16. T16 `tools.surface` through
`ctx.tools.restrict()`. T17 `admit.terminal`. T18 `supervise.goal`. T19
`remind.drift` and `guide.instructions`. T20 the remaining wave 4 modules.

## Wave 1 verification record

Re-run by the orchestrator on 2026-10-07 after the repair, not accepted from an
agent report. Command: `node scripts/gates.mjs` — exit 0, `GATES-ALL-PASS`,
25 markers across 21 scripts.

| Ticket | Markers observed |
|---|---|
| T1 | GATE-T1-COMPOSE-OK, GATE-T1-MANIFEST-OK |
| T2 | GATE-T2-CLIENT-OK |
| T3 | GATE-T3-LEDGER-OK, GATE-T3-PRIORITY-OK, GATE-T3-SHADOW-OK, GATE-T3-REBUILD-OK |
| T4 | GATE-T4-ARBITER-OK |
| T5 | GATE-T5-ISOLATION-OK, GATE-T5-TOGGLE-OK, GATE-T5-DISPOSAL-OK, GATE-T5-SEAM-OK |
| T6 | GATE-T6-ADMIT-OK, GATE-T6-FAILOPEN-OK |
| T7 | GATE-T7-SCREEN-OK |
| T8 | GATE-T8-SKILL-OK |
| T9 | GATE-T9-COMPLETION-OK |
| T10 | GATE-T10-ASK-OK |
| T11 | GATE-LIVE-ACTIVE-OK, GATE-LIVE-STATUS-OK, GATE-LIVE-TOGGLE-OK, GATE-LIVE-UNINSTALL-OK, GATE-LIVE-JUDGE-OK |
| T12 | GATE-T12-PARITY-OK |

`GATE-LIVE-JUDGE-OK` observed: `ref="TYPESAFE_API_KEY" configured=true
skills=true probability=0.95`, and with an absent ref `configured=false
kind=unconfigured`. That gate was added after the first pass because the suite
reported 24 of 24 green while the plugin was inert: the credential was never
resolved and `api.skills` was never exposed, and no module gate could see either,
because module gates drive a synthetic `api` object by design. A mutation test
(credential branch disabled) makes the new gate exit 1 with no marker, which is
what makes it evidence rather than a green light.

Wave 1 is closed and installed into the `web` profile (all modules off; it
activates at the next host start). `navigate.stage` is dropped from the roadmap,
and enabling the `tool-goal` row is left to the operator. **That last clause was
wrong and is corrected in `SPEC.md`:** the web bundle disables its row because
presets own the model-facing tool, and the active preset declares it, so the nag
already reaches the agent.

---

# Wave 2 — the real gaps

New coverage items:

| CID | Required outcome | Owner | Observed by |
|---|---|---|---|
| CID-18 | Terminal log admission keeps failures, summaries, named and slow tests while dropping ordinary passing detail, and never touches a non-terminal result | T17 | G-T17-1 |
| CID-19 | Goal supervision notices a stalled loop once, after a configurable run of rounds without progress, and never repeats within a session | T18 | G-T18-1 |
| CID-20 | Drift and instruction notices obey the arbiter: at most one notice per turn, dedupe by content hash, suppression recorded | T19 | G-T19-1, G-T19-2 |
| CID-21 | Broadcast seams accept several enabled observers; exclusive seams still refuse a second owner | T21 | G-T21-1 |

## T21 — Seam classes in the registry

Blockers: none. Must land before any wave 2 module.

Behaviour: module descriptors declare `seamClass` and, for transforming
exclusive modules, the `targets` they handle. The registry enforces:
`exclusive` owners whose target sets intersect are a startup error naming both,
disjoint-target owners coexist, and `broadcast` accepts many observers dispatched
in registration order, each returning the event unchanged. The five wave 1
modules gain their class and targets, and `tools/result` becomes broadcast.

## Gates

- [x] G-T21-1: two broadcast modules on one seam both run; two exclusive modules with intersecting targets fail startup naming both; two exclusive modules with disjoint targets both run
  CHECK: `node scripts/gate-t21-seamclass.mjs`
  EXPECT: `GATE-T21-SEAMCLASS-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T21-SEAMCLASS-OK` via `node scripts/gate-t21-seamclass.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T17 — admit.terminal

Blockers: T21.

Behaviour: for `bash` and `pwsh` results only, above a token threshold, keep the
parts that matter (failures, summaries, named and slow tests) and drop ordinary
passing detail, judged through the core. Fail-open keeps the whole result. The
scope is disjoint from `admit.output`, which excludes terminal tools on purpose.

## Gates

- [x] G-T17-1: a terminal result keeps its failure and summary lines and drops ordinary passing detail
  CHECK: `node scripts/gate-t17-terminal.mjs`
  EXPECT: `GATE-T17-TERMINAL-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T17-TERMINAL-OK` via `node scripts/gate-t17-terminal.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T17-2: a non-terminal result and a judge failure both leave the result unchanged
  CHECK: `node scripts/gate-t17-failopen.mjs`
  EXPECT: `GATE-T17-FAILOPEN-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T17-FAILOPEN-OK` via `node scripts/gate-t17-failopen.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T18 — supervise.goal

Blockers: T21.

Behaviour: a broadcast observer on `agent/pre-step` that never rewrites the
decision. It raises one arbitrated notice after a configurable run of rounds
without progress, and never repeats it within a session.

## Gates

- [x] G-T18-1: a stalled run raises exactly one notice after the configured rounds, and the decision is returned unchanged
  CHECK: `node scripts/gate-t18-goal.mjs`
  EXPECT: `GATE-T18-GOAL-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T18-GOAL-OK` via `node scripts/gate-t18-goal.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T19 — remind.drift and guide.instructions

Blockers: T21.

Behaviour: two broadcast observers on `agent/pre-step`, each delivering at most
one arbitrated notice per turn and never repeating a summary within a session.

## Gates

- [x] G-T19-1: drift raises one notice per session for a repeated pattern and records suppression
  CHECK: `node scripts/gate-t19-drift.mjs`
  EXPECT: `GATE-T19-DRIFT-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T19-DRIFT-OK` via `node scripts/gate-t19-drift.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T19-2: instruction guidance stays silent when rules are present and raises one notice when they are absent
  CHECK: `node scripts/gate-t19-guide.mjs`
  EXPECT: `GATE-T19-GUIDE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T19-GUIDE-OK` via `node scripts/gate-t19-guide.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

Wave 2 exit: `node scripts/gates.mjs` reports every marker including wave 1, with
no regression, and `--dump-config` still composes with zero skipped bundles.

## Wave 2 verification record

Re-run by the orchestrator on 2026-10-07, not accepted from an agent report.
Command: `node scripts/gates.mjs` — exit 0, `GATES-ALL-PASS`, **31 markers across
27 scripts**, unit tests 45/45. New markers: GATE-T17-TERMINAL-OK,
GATE-T17-FAILOPEN-OK, GATE-T18-GOAL-OK, GATE-T19-DRIFT-OK, GATE-T19-GUIDE-OK,
GATE-T21-SEAMCLASS-OK, plus the five live markers including GATE-LIVE-JUDGE-OK.

Seam-class proof, through the real entry and the real module list, not fixtures:
`admit.output` (exclusive, non-terminal targets) and `admit.terminal` (exclusive,
`bash`/`pwsh`) both start behind one `tools/post-execute` listener with no error;
a descriptor claiming a target another owner already holds fails startup naming
both ids, and the refused composition registers nothing.

Two interruptions worth recording. The first dispatch's foundation agent kept
editing for about fifty minutes after its outcome was already on disk and passing,
so the module phase never started; it was stopped, the frozen state was verified
green by hand, and the remainder was re-dispatched. Lesson: keep a workflow's
foundation phase small, or run it directly — a slow foundation blocks every
dependent phase.

The second is a real disturbance to the operator's live profile, found by diffing
rather than by a report: `dsh-jev-router` disappeared from the `web` profile
during the build. It was restored as a `link:` dependency exactly as it had been,
and the profile now carries both plugins with zero skipped bundles. Any install
into a live profile must be diffed before and after, not assumed.

The plugin is installed into `web` as a `link:` dependency, not a `file:` one.
A `file:` install shares inodes with the source but does not carry NEW files, so
adding a module would leave the installed barrel importing a file that does not
exist there and the next host start would fail. `link:` symlinks the package, so
new module files appear immediately; that was verified by creating a probe file in
the source and seeing it through the installed path.

---

# Wave 3 — the autopilot

Behaviour reference: `/home/sil/dsh-plugins/dsh-jev-autopilot/SPEC.md`. Its hard
gates carry over unchanged, including the `GoalActivation` gate (`phase ===
'active'` and `activation === 'armed'`, verified at
`dsh-goal/lib/types/types.d.ts:58` and `:82`).

New coverage item:

| CID | Required outcome | Owner | Observed by |
|---|---|---|---|
| CID-22 | The nag consumes the plugin-internal `question/evaluated` event published by `answer.questions` at the decision moment, and never observes `user-questions/request` itself | T13 | G-T13-2 |

## T25 — Core event channel

Blockers: T21.

Behaviour: implement `core.events.publish(name, payload)` and
`core.events.subscribe(name, fn) -> unsubscribe` as an in-process channel with no
harness involvement, and expose it to modules as `api.events`. Its only use is
`SEAMS.INTERNAL_QUESTION_EVALUATED`, which exists so the nag reacts to the
decision moment without observing the harness seam that `answer.questions` owns.
A subscriber whose publisher is disabled never fires, and publishing to a name
with no subscriber is a no-op, not an error.

## Gates

- [x] G-T25-1: a published event reaches exactly its subscribers once, unsubscribing stops delivery, and publishing with no subscriber is a no-op
  CHECK: `node scripts/gate-t25-events.mjs`
  EXPECT: `GATE-T25-EVENTS-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T25-EVENTS-OK` via `node scripts/gate-t25-events.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T13 — answer.questions and nag.nogoal

Blockers: T25, T21.

Behaviour: `answer.questions` owns `user-questions/request` as an exclusive
waterfall owner. It answers the whole batch or calls `next()`; a partial batch is
never sent, because the answer must name each question of the call exactly once.
All five hard gates must hold in `enforce`; the default mode is `shadow`, which
records the would-be answer and then delegates anyway. Recall and the judgment run
together under one `deadlineMs` (default 2500); past the deadline or on any error
it delegates and never blocks the agent.

Every decision is written to the ledger, and on a delegation the module publishes
the plugin-internal `question/evaluated` event carrying the failing gate. The
nag consumes that event, not the harness seam, so it is not a second owner.
`nag.nogoal` is inert when `answer.questions` is disabled, and the composition
warns rather than failing. Injection uses `agent.inject()` with the plugin's own
declared source kind and `form: 'notice'`; an unlabelled context renders as a
user prompt in derived history, so the kind is registered by augmenting
`MessageSourceMap`, as the shipped `repeat-tool-reminder` does.

## Gates

- [x] G-T13-1: with an armed goal and a decisive stub judge the whole batch is answered; breaking each gate in turn (disarmed, a free-text question, duplicate labels, a margin below threshold, the ask-human candidate chosen) delegates instead
  CHECK: `node scripts/gate-t13-answer.mjs`
  EXPECT: `GATE-T13-ANSWER-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T13-ANSWER-OK` via `node scripts/gate-t13-answer.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T13-2: exactly one `question/evaluated` is published per delegated question with the failing gate named, in shadow the ledger holds the would-be answer and nothing is answered, and no module observes `user-questions/request` other than `answer.questions`
  CHECK: `node scripts/gate-t13-event.mjs`
  EXPECT: `GATE-T13-EVENT-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T13-EVENT-OK` via `node scripts/gate-t13-event.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T13-3: with the nag enabled and `answer.questions` disabled the composition warns and the nag stays inert; with both enabled, a delegated question with no goal injects exactly one notice carrying form notice and the plugin's own source kind
  CHECK: `node scripts/gate-t13-nag.mjs`
  EXPECT: `GATE-T13-NAG-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T13-NAG-OK` via `node scripts/gate-t13-nag.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T14 — notify.decline

Blockers: T13.

Behaviour: when the autonomy gate held and the outcome is a delegation for any
reason, raise one notification through the core's transport: `url` posting JSON to
`notifyUrl` with optional headers (covers Bark and Home Assistant), or `command`
with `{title}`, `{body}`, `{session}` and `{reason}` substituted. Off by default.
Payload carries the question text and option labels, the failing gate, the session
id and the count of decisions in this goal. At most one per `notifyMinIntervalMs`
(default 60000), hard cap `notifyMaxPerHour` (default 6); a suppressed
notification is counted and recorded, never silently dropped. A failed send never
changes the outcome.

## Gates

- [x] G-T14-1: an armed-goal decline sends exactly one notification; with the transport off nothing is sent; a second decline inside the interval is suppressed and counted; a failing transport still leaves the outcome a delegation
  CHECK: `node scripts/gate-t14-notify.mjs`
  EXPECT: `GATE-T14-NOTIFY-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T14-NOTIFY-OK` via `node scripts/gate-t14-notify.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

Wave 3 exit: the same suite plus these four markers, and the autopilot modules
off by default with `answer.questions` in shadow.

## Wave 5 — the wiring gate and a ledger that survives

Added 2026-10-07 after the waves closed, because the wave-by-wave gates left one
class of defect unmeasured: every module gate drives a synthetic `api`, so nothing
proved the chain from configuration through the registry, the module, the real
core and the judge to an action and a record on disk.

New coverage items:

| CID | Required outcome | Owner | Observed by |
|---|---|---|---|
| CID-26 | An enabled module acts through the real registry and the real core, and the judgment is attributable on disk; in shadow the same chain records the would-be decision and transforms nothing | T26 | G-T26-1 |
| CID-27 | The ledger is written to a file when `ledgerPath` is set, so shadow-mode records survive the host exiting | T26 | G-T26-1 |

## T26 — the wiring gate

Behaviour: with every module off there is no listener on the seam; with
`admit.output` enabled in `enforce`, a `tools/post-execute` event fired the way the
harness fires it returns a transformed result and appends a record naming
`admit.output` to the configured ledger file; in `shadow` the same chain returns
nothing and still records.

## Gates

- [x] G-T26-1: the real chain transforms a result in enforce and records it on disk, and records without transforming in shadow, with a positive control proving no listener exists when nothing is enabled
  CHECK: `node scripts/gate-t26-e2e.mjs`
  EXPECT: `GATE-T26-E2E-OK`
  EVIDENCE: observed 2026-10-07, exit 0

### A finding from writing it

`ledgerPath` did not exist. Every judgment lived in memory, so shadow mode's
promise — record what it would have done, then read it before you trust the
module — was unreadable the moment the host exited. The setting now exists, empty
by default, and the gate asserts the file rather than the in-memory array.

The gate also failed its first run for a reason worth keeping: the fixture joined
its segments with a single newline, the module chunks on blank lines, so the
payload was one chunk and could never be pruned. A gate that proves nothing
because its input cannot exercise the path is a gate that lies.

### Debt closed: a module may declare no seam

`nag.nogoal` and `notify.decline` consume no harness event — they hear the
autopilot's decision on the core's own channel — but a descriptor had to name a
seam, so the registry registered two listeners that could never fire. A descriptor
may now declare `seam: null`. The registry validates it (a module with no seam may
not claim to be exclusive, because it can only observe) and registers nothing for
it, and the status route reports the null rather than a lie.

Five places asserted the old shape and were updated: the descriptor check and the
per-seam owners map in `gate-modules.mjs`, the seam assertion in each of the two
modules' own gates, and the status check in `gate-live.mjs`. That count is the
point: this repository asserts its own structure in five places, and a descriptor
change is a five-file change whether you plan for it or not.

## Wave 3 verification record

Re-run by the orchestrator on 2026-10-07, not accepted from an agent report.
Command: `node scripts/gates.mjs` — exit 0, `GATES-ALL-PASS`, **36 markers across
32 scripts**. New markers: GATE-T25-EVENTS-OK, GATE-T13-ANSWER-OK,
GATE-T13-EVENT-OK, GATE-T13-NAG-OK, GATE-T14-NOTIFY-OK, and the five live markers
including GATE-LIVE-JUDGE-OK (judge configured, probability 0.95; an absent ref
reports unconfigured) and the profile-unchanged check.

**A real defect was found and fixed here, and it is the kind the module gates were
built to catch.** `notify.decline`'s `resolveTransport` read a setting named
`notifyUrl` that the module never declares, so `transport: "url"` resolved to
`off` on every path and the URL transport was dead code. The gate was right and
the module was wrong. The URL belongs to the core, which owns the POST, its
headers, the interval and the hourly cap; the module now returns `url` and lets
the core report sent, suppressed or failed, and it validates only the command
transport, whose field it does own.

Two process notes. The module agent left thirteen `process.stderr.write('DBG …')`
lines in the file and then looped on its own failing gate for thirty-five minutes;
it was stopped and the wave was finished by hand. Removing the debug lines with
`sed` broke the file twice, because two of the deleted lines also closed a `try`
and the `sed` pattern could not see that. The repository has **no version
control**, so the repair was guesswork from reading regions and re-checking with
`node --check`. Initialise a git repository here before the next wave.

**Debt.** `nag.nogoal` declares `agent/inject` as its seam and `notify.decline`
declares `question/evaluated`. Neither is a harness event: both modules consume
the plugin's own event channel in `start()`. The registry therefore registers a
listener on a name that never fires. It is harmless today and it is the wrong
shape — a descriptor that consumes no harness seam should be able to say so.

---

# Wave 4 — large or risky

New coverage items:

| CID | Required outcome | Owner | Observed by |
|---|---|---|---|
| CID-13 | The visible tool set changes at most once per session by default, and the restriction disposer restores the inherited surface | T15 | G-T15-1, G-T15-2 |
| CID-23 | `rank.files` never transforms a result; it ranks and reports | T16 | G-T16-1 |
| CID-24 | `route.interjection` never rewrites the pre-step decision | T20 | G-T20-1 |
| CID-25 | `approve.workspace` returns `ask` only for an eligible single-operation escalation in `workspace-write`, and a non-affirmative answer returns to human approval | T23 | G-T23-1 |

## T15 — tools.surface

Blockers: T21. Off by default.

Behaviour: reduce the presented tool set for the calling agent scope through
`ctx.tools.restrict(filter)`, registered per agent through the registry's
`registerAgent` so its disposer lifts the restriction. Because every change
rewrites the tool schemas in the prompt prefix and so invalidates the prompt
cache, the module computes its set once and changes it AT MOST ONCE per session
by default, and says so in its settings. The filter may use `allow` and/or
`deny`; restrictions intersect and can only reduce, never add.

## Gates

- [x] G-T15-1: a restricted probe tool is absent from the presented set while an unrestricted one is present, and disposing the restriction restores it (the positive control proves the probe distinguishes present from absent)
  CHECK: `node scripts/gate-t15-restrict.mjs`
  EXPECT: `GATE-T15-RESTRICT-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T15-RESTRICT-OK` via `node scripts/gate-t15-restrict.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)
- [x] G-T15-2: with defaults, the set changes at most once per session, and a second requested change is refused and recorded
  CHECK: `node scripts/gate-t15-once.mjs`
  EXPECT: `GATE-T15-ONCE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T15-ONCE-OK` via `node scripts/gate-t15-once.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T16 — rank.files

Blockers: T21.

Behaviour: a broadcast observer that never transforms a result. It ranks
`glob`/path candidates to steer the next read and reports the ranking (through
the ledger, and through one arbitrated notice when it has something to say).
`admit.output` remains the only transformer of `glob` output on that seam.

## Gates

- [x] G-T16-1: the observed event is returned unchanged, the ranking is recorded, and no result transformation occurs
  CHECK: `node scripts/gate-t16-rank.mjs`
  EXPECT: `GATE-T16-RANK-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T16-RANK-OK` via `node scripts/gate-t16-rank.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T20 — route.interjection

Blockers: T21. Delivery mechanism must be resolved before implementation.

Behaviour: route a running user's correction to the next step and queue other
messages. It must NOT rewrite the `agent/pre-step` decision, because that seam is
broadcast and `select.skill` shares it. If delivering a queued correction
genuinely requires rewriting the decision or the message list, stop and report:
that needs an exclusive seam, and the exclusive-owner decision is not the
implementer's to make silently.

## Gates

- [x] G-T20-1: the pre-step decision is returned deep-equal to its input, and a correction is queued exactly once for the next step
  CHECK: `node scripts/gate-t20-interjection.mjs`
  EXPECT: `GATE-T20-INTERJECTION-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T20-INTERJECTION-OK` via `node scripts/gate-t20-interjection.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T23 — approve.workspace

Blockers: T21.

Behaviour: on `tools/pre-execute` as the exclusive owner, return `ask` for an
eligible single-operation escalation request in `workspace-write`; any
non-affirmative or low-confidence judgment returns to human approval rather than
allowing. Never auto-allow a destructive call.

## Gates

- [x] G-T23-1: an eligible escalation returns ask; a non-eligible one passes through; a failing judge passes through rather than allowing
  CHECK: `node scripts/gate-t23-approve.mjs`
  EXPECT: `GATE-T23-APPROVE-OK`
  EVIDENCE: observed 2026-10-07 — `GATE-T23-APPROVE-OK` via `node scripts/gate-t23-approve.mjs`, green in the full suite (43 markers, 39 scripts, exit 0)

## T24 — guide.shared

Blockers: T21.

Behaviour, as reopened on 2026-10-07 and specified before building. The module
observes `agent/pre-step` as a broadcast owner and never rewrites the decision.

**The recipient map comes from the session's own tool calls.** Sending to another
agent is the shipped `send_message` tool, which takes an `agent_id`, and the call
is recorded in the sender's session with its arguments. `handle` reads the
session's derived messages, collects trailing `send_message` calls inside a
lookback window, and holds the most recent text per recipient, per session. No
cross-session store is involved: the record this module needs is its own log.

**A correction is one Jev `noul` judgement per changed pair.** When the text for a
recipient changes from what that recipient was last told, the module asks one
question — does the new message contradict what this recipient was told before —
and acts only above a probability threshold. A judge failure, an unreadable
answer, or a refused budget delivers nothing.

**Delivery is `ctx.agents.get(id)` then `agent.inject(...)`**, both already
bridged and verified. The message carries the plugin's own source kind and
`form: 'notice'`. Each (recipient, content hash) is delivered at most once per
session, and a session cap bounds the module.

**Limits by construction:** a session that never sent anything is a no-op; shadow
mode records the correction and delivers nothing; the observed event is returned
untouched.

## Gates

- [x] G-T24-1: two conflicting sends to one recipient produce exactly one injected correction to that recipient and none to an agent told nothing inconsistent; identical sends produce nothing (positive control); the decision comes back deep-equal; a session with no sends is a no-op; shadow records without injecting
  CHECK: `node scripts/gate-t24-shared.mjs`
  EXPECT: `GATE-T24-SHARED-OK`
  EVIDENCE: observed 2026-10-07, exit 0 on the first run, and again inside the full suite

Wave 4 exit: the same suite plus these markers, every wave 4 module off by
default, and the operator informed of the prompt-cache cost that `tools.surface`
carries if they enable it.

## Wave 4 verification record

Re-run by the orchestrator on 2026-10-07. Command: `node scripts/gates.mjs` —
exit 0, `GATES-ALL-PASS`, **41 markers across 37 scripts**, with sixteen modules
loaded and live activation verified in a throwaway profile. New markers:
GATE-T15-RESTRICT-OK, GATE-T15-ONCE-OK, GATE-T16-RANK-OK,
GATE-T20-INTERJECTION-OK, GATE-T23-APPROVE-OK.

**T24 `guide.shared` is CLOSED as out of scope, not delivered.** The
investigation this round found that its premise does not exist: `ContextForm`
defines a `relay` as a message another agent addressed to this one
(`@deepseek-ai/dsh-llm/lib/types/message.d.ts:56` and `:90`), but no shipped
package produces or consumes one, and nothing records which agents received a
given finding. A module observing one session's `agent/pre-step` cannot compute
"affected recipients" without inventing a cross-session correlation store, and
that needs its own spec before its own code. The delivery half is solved and
available: `ctx.agents.get(id)` and `list()` are bridged as `api.agents`. CID-24
stays open as an unmet requirement with its reason recorded, and gate G-T24-1 is
unwritten by design. The first agent assigned this produced no file in forty-five
minutes; the second produced none in twenty-five and was stopped, which is why the
ticket was settled by reading the harness rather than by asking a third time.

**REOPENED the same day, because the closure was wrong.** The claim was that
nothing records which agents received a finding. It is false: `send_message` is a
shipped model-facing tool, it takes an `agent_id`, and every tool call is recorded
in the SENDER's own session with its arguments — which a module can read at
`agent/pre-step`, exactly as `remind-drift` already reads tool-call arguments. What
had actually been verified was narrower and stayed true: the `relay` context form
has no shipped producer. The mistake was treating one empty search, on the producer
side, as proof about the whole flow. The operator caught it with domain intuition
("isn't it based on the subagents built in to dsh?"), not with a test, and the
lesson is now in memory: an empty search is not a finding; enumerate every side of
the flow and say which sides were checked. T24 is back in scope with the design
below.

**The repeat chore is now recorded.** Four separate places enumerate the shipped
modules and every one needed updating this wave: the `SHIPPED` array and the
per-seam owners map in `gate-modules.mjs`, the `EXPECTED` map in
`gate-t21-seamclass.mjs`, its two per-seam count assertions, and the expected id
list in `gate-live.mjs`. A module that is added without all of them turns the
suite red for the wrong reason, which is exactly what happened twice.

**The wave-4 constraints that held.** `tools.surface` ships off by default and
changes the presented set at most once per session, because each change rewrites
the tool schemas inside the prompt prefix and invalidates the cache.
`route.interjection` returns the pre-step decision deep-equal and queues instead
of rewriting. `rank.files` never transforms a result. `approve.workspace` returns
`ask` and passes through on a failing judge rather than allowing.

## Wave 5 verification record

Re-run by the orchestrator on 2026-10-07, after the wiring gate, the persistent
ledger, `seam: null` and the reopened `guide.shared`. Command:
`node scripts/gates.mjs` — exit 0, `GATES-ALL-PASS`, **43 markers across 39
scripts**, with seventeen modules loaded and live activation verified in a
throwaway profile.

Markers added since the wave 4 record, two scripts and two markers:
`GATE-T26-E2E-OK` (the wiring gate: real registry, real shipped module list, real
core, judge transport stubbed) and `GATE-T24-SHARED-OK` (the reopened module).
Three markers kept their names and changed their assertions: `GATE-MODULES-OK`
(seventeen ids, one owner per seam), `GATE-T21-SEAMCLASS-OK` (`guide.shared` in the
broadcast map, six observers behind one `agent/pre-step` listener), and the five
`GATE-LIVE-*` markers (the expected id list). The forty-one gates that this file
previously listed as `EVIDENCE: pending` now carry their marker, their script and
this run as their evidence.

## Live verification against the operator's own host, 2026-10-07

Asked whether the plugin works, the honest answer required checking the running
host rather than the suite. Three findings, none of which any gate could see.

1. **The judge was 401 in the live profile.** `endpoint` defaulted to
   `https://api.typesafe.ai/v1/systemone` with `model: jev-latest`, and the stored
   credential is rejected there (`authentication_error`). The same credential
   authenticates at `https://opencode.ai/zen/v1/systemone` with `jev-1.13-free`
   and returns a judgement, which is the pair `gate-live` uses in its throwaway
   profile — so the gate proved the plumbing, never this host's configuration.
   The operator chose the fix; both settings are written, and the live probe now
   returns `ok: true`, probability 0.95, `lastError: null`.
2. **The running host holds a stale build.** It started at 09:32 and loaded the
   plugin at install time; the loader caches ESM, so the five wave-1 modules are
   what this process has, and the other twelve need a restart. The fix in (3)
   reaches the host the same way.
3. **`dispatch` discarded `result` on a waterfall seam — the plugin was inert in
   production.** The harness calls `tools/post-execute` as `(exec, result, next)`
   (`PostToolDecision` waterfall, and `next()` accepts the result unchanged). The
   registry packed `{exec, result}` only when no `next` was present, so every real
   dispatch handed the module the exec alone; both `admit.output` and
   `admit.terminal` then fell back to `next()` — which never carries content — and
   returned without acting or recording. Reproduced live: two tool calls on that
   seam, zero ledger rows, no warning.
   `RESULT_PAIR_SEAMS` now packs those seams whatever the mode, and
   `gate-t26-e2e.mjs` passes the continuation the way the harness does. That gate
   previously called `listener(EXEC, RESULT)` — the one shape the harness never
   uses — which is why a green end-to-end marker certified the defect. It fails on
   the old dispatch and passes on the new one.

Verified after the fix: `node scripts/gates.mjs` exit 0, `GATES-ALL-PASS`, **43
markers across 39 scripts**; unit tests 46 of 46. The two modules enabled during
the investigation are off again; the profile keeps only the judge endpoint change.

### After the restart: the `link:` install cost the schema

The restart loaded all seventeen modules and the judge answered (`ok: true`,
probability 0.95). Then the settings write was refused:

```
{"ok": false, "error": "No configurable plugin entry \"dsh-jev-layer\""}
```

Cause: a `link:`ed plugin has no `node_modules` anywhere above its real path, so
`await import('@deepseek-ai/schemastery')` fails, `Config` degrades to `undefined`,
and `dsh-settings` refuses to configure an entry without a schema. The plugin loses
its settings page and its own settings route — the very surface needed to switch a
module on — while every gate stays green, because the gates install with `file:`,
where the bare specifier resolves. The earlier `file:` install had a copied tree
inside the profile, which is why this appeared only after the switch to `link:`.

`config.js` now resolves the library through three roots: the bare specifier, the
harness entry point's own `@deepseek-ai/dsh` package, then any
`$DSH_HOME/profiles/*/node_modules`. Verified from the repository: `Config` is
built with 26 top-level fields. `gate-t1-manifest.mjs` asserts the entry exports a
schema, and the entry test now points `HOME` and `argv[1]` at its temp tree so it
still proves the documented degradation instead of passing by accident. Both fixes
need one more restart to reach the running host.

Still open after this wave: rotation of the four credentials exposed on
2026-10-07. The `tool-goal` row is **not** an open item: the web bundle disables it
because presets own the model-facing tool, the active preset supplies it, and the
nag therefore reaches the agent. The earlier request for that decision was based
on reading the profile plane alone; see the correction in `SPEC.md`. That leaves
the credential rotation as the only outstanding item, and it belongs to the
operator.

## The settings page, and the credential gap, 2026-10-08

**A host-only plugin has no page in DSH 0.2.** Both host-side settings registration
faces were removed; the entry's own `Config` is the settings document, and the
Plugins section is the client list slot `settings.plugins.tab`. The entry appeared
only in the generic inventory tab — which the operator found unintelligible, hence
three changes:

- `packages/plugin/client.js`: a browser half registering one tab (`Jev layer`,
  order 70) that renders the entry's own form through
  `configForms.get('dsh-jev-layer')`. Writes go over the settings transport, so a
  toggle applies live.
- Help text comes from the plugin's schema, read through
  `configForms.describe()`. The first walk expected a nested `dict` tree — an
  invented shape. The real envelope is `{uid, refs}`, where a `dict` value is a ref
  id to resolve. The walk was fixed and the gate now feeds it the plugin's own
  serialized schema; the invented fixture had agreed with the bug.
- Every module carries a one-line purpose (the README's sentence, in the module
  file), and `buildConfig` attaches it, so a heading reads as a purpose rather than
  `screen.fetch`.

**The credential gap.** After every boot the judge reported `configured: false`
until something wrote settings or called the probe, because the credentials store
mounts after the plugin does. Modules that ask anyway recover; modules that check
`configured` first fail open in silence. The boot now re-resolves when the store
appears (`ctx.inject(['credentials'], …)`) and once per judgment while the key is
missing. `gate-live`'s active check asserts the credential resolves with no settings
write and no probe, polled for fifteen seconds; reverting the fix in place makes
that check fail, so it is a check that can fail.

## Independent review, 2026-10-07 — five defects, all fixed

An independent reviewer (`copilot/gemini-3.8-flash`, read-only, 35-call cap) read
`guide-shared.js`, the gate, `registry.js`, the core and the DSH ground truth, and
returned five defects. All five were real. Its verdict was that the marker count
alone is not evidence for this module, and it was right: the suite was green while
`guide.shared` was broken.

1. **Critical — `guide.shared` reversed its own correction.** The host replays the
   whole appended history on every step; the module walked that history while
   updating its own memory of what each recipient had been told, so on the next
   step it read the OLD statement as a fresh change and injected a correction
   sending the recipient back to the superseded text. Reproduced here before
   touching anything: step 3 of a settled session injected
   `earlier: ...220 | current: ...118`. Fixed by reading the latest text per
   recipient first, then comparing. `gate-t24-shared.mjs` now replays cumulative
   history and asserts a settled session asks and injects nothing; the new
   assertions fail on the pre-fix module (`2 !== 1` on the judge count).
2. **High — the gate hid it.** The idempotence check pruned the history to the one
   message it cared about, so the fixture could not express the defect. Fixed with
   the cumulative fixtures above, and the rule is now in `docs/CONTRACT.md` under
   Gates: a gate that drives session history replays it append-only.
3. **High — `api.agents` and `api.inject` were undeclared.** The frozen api block
   in `docs/CONTRACT.md` listed neither, and said `registerAgent` was the only way
   a module touches an agent, while three modules already delivered through
   `api.inject`. Both members are now declared with their failure behaviour, the
   `registerAgent` sentence is qualified (per-agent *registration*, not access),
   the registry comment is corrected to match, and the contract states that an
   `apiFor` member with no line there is a contract defect.
4. **Medium — the ledger silently dropped `reason`.** `RECORD_KEYS` did not carry
   it, so five modules that pass a reason lost it, and this module's docstring
   claimed the ledger said why. Fixed in the shared schema rather than in five call
   sites; the contract lists the key and the core test asserts a reason travels.
   Three gates (`t3-ledger`, `t15-once`, `t16-rank`) pin the record shape and were
   updated — the contract shape is enumerated in six places now.
5. **Medium — an emit seam handed back an array.** `runBroadcast` returned the
   observers' return values when a seam had no continuation, so a caller could
   receive values the contract says an observer never produces. It now returns
   nothing on an emit seam and warns on any stray return, as it already did on a
   waterfall seam. `entry.test.js` and `gate-t16-rank.mjs` asserted the old array
   and now assert `undefined`.

Verified after all five: `node scripts/gates.mjs` exit 0, `GATES-ALL-PASS`,
**43 markers across 39 scripts**; unit tests 46 of 46 (one added for `reason`).
Not fixed, and stated as a limit: the reviewer could not run the live gates under
its instructions, so live cross-agent delivery is asserted by `GATE-LIVE-*` and
`gate-t26-e2e` rather than by an agent-to-agent turn in a running session.
