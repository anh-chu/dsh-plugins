# Spec: dsh-jev-layer — one Jev decision layer for DeepSeek Harness

Status: draft for approval. Name `dsh-jev-layer` is a placeholder.
Host: DSH 0.2.0-rc.2, profile `web`, Linux.
Supersedes: nothing. It absorbs the intended scope of `dsh-jev-autopilot`
(`/home/sil/dsh-plugins/dsh-jev-autopilot/SPEC.md`) as modules, and it replaces
three third-party plugins once parity is reached: `dsh-jev-tools` 0.1.13
(installed), `luobosibing2/dsh-jev-plugin`, `RickT34/dsh-just-enough-tools`.

## Problem statement

Three plugins and one draft each implement part of a decision layer around the
Jev (System One) model, and each brings its own judge client, settings page,
budget, ledger and failure mode. Running more than one at a time puts two judges
on the same hook: `dsh-jev-tools` prunes `grep` results while
`luobosibing2/dsh-jev-plugin` also rewrites tool results, so the outcome depends
on registration order and the judge is paid for twice.

None of them runs as published on this host: `luobosibing2` and
`just-enough-tools` pin `@deepseek-ai/dsh*` peers to exactly `0.1.7-rc.2` and
`0.1.7-alpha.1`. Only `dsh-jev-tools` mounts, and its endpoint only started
working on 2026-10-06 after a row-id fix.

The capabilities the user wants exist; the packaging is what is wrong.

## Solution

One plugin, `dsh-jev-layer`, built on one core package. Every capability is a
module behind a registry: one module per seam, one volatile config switch per
module, every module off on a fresh install. The plugin owns the decision layer
outright, so exactly one module ever acts on a given hook, and `dsh-jev-tools`
is uninstalled once parity is verified.

## User stories

- As the operator, I install one plugin and one core package, and I switch each
  capability on or off individually without a restart.
- As the operator, I see, per feature, what the judge would have done before it
  is allowed to act, so thresholds are chosen from measurements.
- As the operator, I pay once for one judge client and one ledger, and the
  answer path outranks pruning when the budget is tight.
- As the operator, when the agent asks me a question inside an armed goal loop
  with nobody watching, the plugin answers it or tells me it could not.
- As the operator, I can uninstall the plugin and the harness returns to stock
  behaviour with no orphaned per-agent registrations.

## Implementation decisions

### Packaging

One repository, pnpm workspace, at `/home/sil/dsh-plugins/dsh-jev-layer`:

- `packages/core` — the judge and the shared machinery. Imports nothing from
  DeepSeek Harness or Cordis, so it is testable with no host and no network.
- `packages/plugin` — the installable bundle. Declares `dsh.bundle.patch` and
  the client half if one is needed. Depends on core through the workspace link.

The core is **not** a separately installed package. The earlier proposal to
publish it and have two plugins depend on it by `file:` assumed two plugins; with
one plugin that only adds pnpm hard-link hazards (editing the core would edit the
installed copy, and a `git checkout` in the core would rewrite what is installed).
A workspace keeps the interface boundary without those hazards. Extract it to a
package only if a second consumer appears.

The manifest declares `engines.dsh: ">=0.2.0-0 <0.3.0"`. A `*` range is
forbidden: the gate replaces `*` with the running version and the declaration then
proves nothing. `>=0.2.0-0 <0.3.0` is the range the one shortlisted third-party
plugin that documents 0.2 support uses.

### Feature registry and lifecycle

The registry is the only place that knows the module list. Each module declares:

- `id` — stable, used for the config key, the ledger, the shadow record and the
  notice tag.
- `seam` — the one extension point it owns, from a closed set. Registering two
  enabled modules on one seam is a startup error, not a silent precedence rule.
- `config` — one schemastery field marked `.volatile()`. DSH rejects a write to a
  non-volatile field, so runtime toggling requires it.
- `start(ctx)` / `stop()` — `stop()` must release everything `start` registered.

Three rules, each with a reason from the installed harness documentation
(`skills/cordis-plugin-development/references/practices.md`):

1. **Lazy, isolated start.** The plugin's `apply()` returns before any module
   starts. Each module starts inside its own `try/catch`. A throw during
   `apply()` fails the whole loader entry and would take every feature offline;
   lazy start degrades one broken feature to "off" instead.
2. **Per-module ownership of per-agent registrations.** Per-agent behaviour is
   registered on `agent.ctx`, obtained in an `agent/created` listener, wrapped in
   that module's own `agent.ctx.effect()`, with the disposer kept keyed by agent.
   Unloading the plugin does not dispose `agent.ctx` registrations by itself, so
   the module must dispose its own, both on toggle-off and on unload.
3. **The plugin memory is a derived cache.** The session log is the only source of
   truth (practices.md principle 1). The ledger and any cached judgment must be
   rebuildable from committed session events, and deleting them must not change
   behaviour.

### Seams, with exactly one owner each

| Seam | Owner module(s) | Mechanism |
|---|---|---|
| `tools/post-execute` | `admit.output`, `admit.terminal` | Transform a result. Terminal and non-terminal tools are disjoint sets, so one seam with disjoint targets is safe |
| `tools/result` | `ledger`, `budget` | Observe outcomes only; never transform |
| `tools/pre-execute` | `approve.workspace` | Return `ask` to consult the user; `ctx.tools.guard()` cannot await |
| `ctx.tools.restrict()` on `agent.ctx` | `tools.surface` | Reduce the inherited tool surface; see below |
| `agent/created` | every module with per-agent state | Via the registry's shared listener, dispatching by module id |
| `user-questions/request` | `answer.questions` | Waterfall: return an answer, or call `next()` |
| `agent.inject()` | `remind.drift`, `guide.instructions`, `nag.nogoal` | All notices go through the core's arbiter, so several modules may want a notice without owning the seam |
| plugin-internal `question/evaluated` | `nag.nogoal` | Published by `answer.questions` at the moment it decides to delegate. The nag must not observe `user-questions/request` itself, or it becomes a second owner of that seam. This is a declared soft dependency, not an accident: with `answer.questions` off there is no delegation decision, so the nag has no trigger and stays inert |
| `agent/pre-step` | `supervise.goal`, `route.interjection` | Advisory only in v1 |
| skill catalog assembly | `select.skill` | One owner: `jev-tools`' single-pick and `luobosibing2`'s ranking are reconciled into one implementation, not both |

Verified contracts:

- `user-questions/request` is a waterfall:
  `(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>`
  (`@deepseek-ai/dsh-user-questions/lib/types/index.d.ts:145`). The service also
  exposes `answer(agent, callId, answer)` at `:56`.
- `restrict(filter: ToolRestriction): () => void` — "Restrict global tools for the
  calling agent scope... Restrictions intersect; scoped registrations remain
  visible" (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:644`). The filter takes
  `allow` (keep only) and/or `deny` (remove).
- `GoalActivation = 'armed' | 'disarmed'`, "Whether this live process may
  automatically continue an active goal", available as `GoalView.activation`
  (`@deepseek-ai/dsh-goal/lib/types/types.d.ts:58` and `:82`).

### `tools.surface` is not progressive revelation

`restrict()` only reduces the inherited surface: restrictions intersect and a
tool the deployment does not provide can never be added. "Start narrow, reveal
later" is therefore expressible only as a sequence of restrictions being lifted,
and every change rewrites the presented tool set, which is the prompt prefix.

So the module computes one set and changes it rarely, if ever, within a session.
It ships off by default. This is the sanctioned mechanism (it keeps schema
presentation, lookup and execution aligned) and the same posture
`dsh-jev-router` takes for model switching, which also invalidates the cache.

### Modules

Delivery waves are delivery order only; the spec covers all of them.

Wave 1 — core plus parity with the installed baseline:

| id | Behaviour | Source |
|---|---|---|
| core | judge client, limiter, budget, ledger, shadow, notice arbiter | new |
| `admit.output` | Keep the task-relevant segments of `read`, `grep`, `glob`, `web_fetch`, `web_search` results above 2000 tokens; retention is scattered, not one contiguous cut | `dsh-jev-tools` 0.1.13 |
| `screen.fetch` | Flag instructions aimed at the model inside fetched page text, above a threshold | `dsh-jev-tools` |
| `select.skill` | Pick at most one skill per turn from a catalog of 15 or more | `dsh-jev-tools`, reconciled with `luobosibing2` selection |
| `gate.completion` | Check the final answer's claims against recorded evidence; model-invoked `jev_gate` plus an automatic variant | `dsh-jev-tools` + `luobosibing2` |
| `tools.ask` | The `jev_ask` tool: typed questions in, probabilities out | `dsh-jev-tools` |

Wave 2 — the real gaps:

| id | Behaviour | Source |
|---|---|---|
| `admit.terminal` | Log admission for `bash` and `pwsh` results only, the output the baseline deliberately refuses to touch | `luobosibing2` output-admission, 38 KB across three modules |
| `supervise.goal` | Check progress between steps, and pause after a configurable run of rounds without progress | `luobosibing2` supervision.ts, 25 KB |
| `remind.drift` | One non-blocking notice per drift event, through the notice arbiter | `luobosibing2` |
| `guide.instructions` | Read the current instructions and rules, deliver one notice when guidance is missing | `luobosibing2` |

Wave 3 — the autopilot scope, absorbed:

| id | Behaviour | Source |
|---|---|---|
| `answer.questions` | On `user-questions/request`, answer or delegate. Answers only when every hard gate holds; default mode is shadow, which records the would-be answer and then delegates anyway | `dsh-jev-autopilot` SPEC.md |
| `notify.decline` | On a declined question in an armed goal, notify through a transport; at most one message per 60 s, 6 per hour, suppressed sends counted | `dsh-jev-autopilot` SPEC.md |
| `nag.nogoal` | When a question was delegated and no goal exists, inject one labelled notice; target auto-selects agent or operator | `dsh-jev-autopilot` SPEC.md |

The autopilot's own hard gates, answer contract, label handling and its 18
acceptance criteria carry over unchanged. Its `GoalActivation` gate is the
autonomy signal: answer only when a goal is active and `activation` is `armed`.

`nag.nogoal` triggers on the plugin-internal `question/evaluated` event, not on
`tools/result` and not on `user-questions/request`. Observing the seam would
break one-owner-per-seam. Observing `tools/result` instead would be legal but
would fire only after the question settles, which in the case the nag exists to
report — an armed loop with nobody there to answer — may be never, or only after
the wait expires. The decision moment is when the condition becomes knowable, and
it is inside `answer.questions`. The detail a notification needs (the question,
its option labels, the gate that caused the decline) is read from the core
ledger, keyed by call id, so the nag depends on the core and not on another
module's internals.

Wave 4 — large or risky:

| id | Behaviour | Source |
|---|---|---|
| `tools.surface` | Restrict the visible tool set for the calling scope; off by default, rare changes | `just-enough-tools`, redesigned per above |
| `rank.files` | Rank `glob`/path candidates to steer the next read | `luobosibing2` selection.ts |
| `route.interjection` | Route a running user's correction to the next step; queue other messages | `luobosibing2` interjection.ts, 23 KB |
| `guide.shared` | Compare already-shared reports and send corrections to affected recipients; multi-agent only | `luobosibing2` shared-findings.ts, 28 KB |
| `approve.workspace` | Answer eligible single-operation escalation requests in `workspace-write`; any non-affirmative answer returns to human approval | `luobosibing2` workspace-approval.ts, 19 KB |
| `navigate.stage` | Classify completed steps into stages and link them to trajectory evidence | `luobosibing2`, ~76 KB, mostly UI |

Modules from the earlier shortlist that are dropped, with reasons: no module
duplicates another's behaviour. `select.skill` is one implementation, not two;
`gate.completion` absorbs both completion designs.

### Core interfaces

- **Judge client.** `ask(state, questions) -> answers | null`. Never throws.
  Endpoint, model and timeout come from settings; the endpoint is a setting, never
  a constant. Default `https://api.typesafe.ai/v1/systemone` and `jev-latest`;
  the working route on this host is `https://opencode.ai/zen/v1/systemone` with
  `jev-1.13-free`. Credentials resolve through the DSH credential store, never a
  plugin-private key file.
- **Fail-open is per call site, passed as a parameter.** Pruning failure keeps
  everything; an answering failure delegates to the human. Both are "do nothing",
  but only the caller knows which.
- **Limiter.** One shared limiter with 429/529 backoff for all modules, because
  all of them share one endpoint and one credential.
- **Budget.** One shared per-turn ceiling with per-feature sub-budgets. Priority
  is explicit: `answer.questions` outranks pruning modules, because a blocked
  question blocks the agent while a missed prune only costs tokens.
- **Ledger.** Append-only records keyed by feature id, holding the question, the
  probabilities, the threshold, the decision, and in shadow mode what would have
  happened. Rebuildable; never authoritative.
- **Notice arbiter.** At most one notice per turn and a per-session cap;
  blocked-state notices outrank advisory ones; dedupe by content hash; a summary
  is never repeated within a session; a suppressed notice is recorded, not
  dropped. Every notice is injected with the module's own source kind and
  `form: 'notice'`, because an unlabelled context renders as a user prompt in
  derived history.
- **Notification transports.** Generic: an HTTPS POST to a URL with optional
  headers, or a shell command with the message substituted. Rate limited as
  above, off by default, and a failed send never changes a decision.

### Settings

One schema, one settings page, generated from the `Config`. Each module
contributes one volatile boolean plus its own tunables. Global fields: endpoint,
model, credential ref, per-turn ceiling, default shadow/enforce mode, notification
transport. Every module defaults to off; `answer.questions` defaults to shadow.

## Testing decisions

- The core is pure: judge client, budget, priority, arbiter, gates and the answer
  contract are tested with a stub transport, no host and no network. This is where
  most tests live, because every gate is decidable there.
- Seam behaviour is tested against a real harness in a throwaway profile, using
  the method already proven on the router fork: `dsh --profile <tmp>
  --from-default-profile web --dump-config` for gate and composition, the repo's
  own verification script for host and client halves, and a live route read-back
  for settings.
- The registry's one-owner-per-seam rule is a static test over the module list,
  not a runtime hope.
- The failure-isolation rule is tested by making one module throw on start and
  asserting the others still start and the entry still activates.

## Acceptance criteria

1. On a fresh install every module is off, and `--dump-config` exits 0 with zero
   `skipping profile bundle` lines on DSH 0.2.0-rc.2.
2. `engines.dsh` is `>=0.2.0-0 <0.3.0`, and no peer range is `*` for a
   `@deepseek-ai/dsh*` package.
3. Starting a module that throws does not fail the loader entry; the remaining
   modules start, and the ledger records the failed module as off.
4. Toggling any module at runtime (volatile write) takes effect without a restart.
5. Disabling a module disposes its per-agent registrations: a probe asserts the
   `agent.ctx` disposer ran, and no handler remains for that agent.
6. Two enabled modules cannot claim one seam: the composition fails at startup
   with the two ids named.
7. In shadow mode the ledger records the would-be decision and no action is taken
   on tool output, tool surface, skills or questions.
8. With the ceiling exhausted, `answer.questions` still gets its sub-budget and
   pruning is the module that starves.
9. Two modules requesting a notice in one turn produce exactly one notice; the
   loser's suppression is recorded.
10. Deleting the ledger and rebuilding from the session log yields the same
    decisions for a recorded session.
11. `answer.questions` answers only when every gate holds; a batch with a
    free-text question, duplicate labels, or a margin below threshold delegates.
12. A declined question in an armed goal sends at most one notification, and a
    failed send does not change the delegate outcome.
13. `tools.surface` changes the presented tool set at most once per session by
    default, and a probe confirms the removal is visible to the model and the
    restriction disposer restores the inherited surface.
14. Parity check: with wave 1 enabled and `dsh-jev-tools` uninstalled, the same
    tool result, skill suggestion and completion verdict are produced for a
    recorded session.
15. Uninstalling the plugin leaves no per-agent handlers registered.
16. With `nag.nogoal` enabled and `answer.questions` disabled, the composition
    warns and the nag stays inert rather than failing startup, and the ledger
    records that it had no trigger.

## Out of scope

- **`guide.shared` (T24): REOPENED 2026-10-07, after being closed in error.** It
  was closed the same day on the claim that "nothing records which agents received
  a given finding". That claim was false, and the correction is recorded here
  rather than deleted. Sending to another agent is the shipped model-facing tool
  `send_message`, which takes an `agent_id`, and every tool call is recorded in the
  SENDER's own session together with its arguments; a module reading its session at
  `agent/pre-step` can therefore see exactly what it sent to whom. The module now
  planned reads that history to build its recipient map.
  The narrower fact that was verified still holds: the `relay` context form
  (`@deepseek-ai/dsh-llm/lib/types/message.d.ts:56` and `:90`) has no shipped
  producer. The error was drawing a conclusion about the whole flow from one empty
  search, on the producer side only, and never looking at the sender's log. The
  delivery half was already available: `ctx.agents.get(id)` and `list()`, bridged
  as `api.agents`. No cross-session store is needed.
- Model or reasoning-effort routing. That is `dsh-jev-router` (already forked at
  `/home/sil/dsh-forks/dsh-jev-router`), not this plugin.
- The memory work: ranking Mnemosyne hygiene candidates and reranking recall.
  Those are script-level actions against the Mnemosyne CLI, already specified
  separately, and they need no plugin.
- `jev_search` from `jipika/dsh-jev-grep`. Deferred: `admit.output` already owns
  `grep` output. Revisit only if a measured side-by-side on one real flood shows
  line-level ranking beats segment retention.
- Any new session event type. The Session refuses an unknown stored type unless
  the envelope carries `ignorable: true`, which `append()` cannot set.
- Web UI beyond the settings page in v1, except `navigate.stage` in wave 4.

## Further notes

- Measured judge behaviour on this host (2026-10-06, `jev-1.13-free` via
  `opencode.ai/zen/v1/systemone`): a blind 24-line adjudication of a real grep
  flood separated cleanly — 14 real call sites scored 0.82–0.98, 10 look-alikes
  scored 0.05–0.08 — and repeating identical input twice changed one value by
  0.01. That measures the judge, not any plugin, and it does not measure whether
  line ranking beats segmentation.
- The earlier "not repeatable" verdict for Jev came from a wrapper using an
  OpenCode Go chat model as judge, which returns counts where a probability
  belongs. Do not use a generative model as a judge substitute.
- Migration: `dsh-jev-tools` stays installed and unmodified until criterion 14
  passes, then it is removed. Two judges on one hook is the failure this design
  exists to prevent.
- The autopilot session (`session-8f988d64`) verified the `agent.inject()`,
  `agent.ctx` disposal and `GoalActivation` behaviour, and agreed to fold in
  rather than ship separately. Its SPEC.md remains the behaviour reference for
  the wave 3 modules.
- **CORRECTED 2026-10-07: `nagTarget: auto` does reach the agent on this machine.
  The note below stopped one plane short.** It said: `@deepseek-ai/dsh-tool-goal`
  (row `tool-goal`) and `@deepseek-ai/dsh-command-goal` (row `command-goal`) are
  both disabled in the web profile, so the model has no tool for setting a goal and
  only the operator can create one from the goal UI; evidence, the rows are
  declared at `dsh-base/cordis.patch.yml:437-438`, disabled for web at
  `dsh-web-app/cordis.patch.yml:496`, and `~/.dsh/profiles/web/cordis.patch.yml`
  does not override either. Every one of those statements is true, and every one is
  about the profile plane. The web bundle states why it disables them: *"Presets own
  the human command and model-facing tool."* The active preset does exactly that —
  `~/.dsh/.agent-presets/standard-jev/agent.cordis.yml:95-99` declares
  `command-goal` and `tool-goal` with no `disabled` — so both are in the agent's
  toolbox. Observed directly rather than inferred: this session has `create_goal`,
  `get_goal` and `update_goal`. The nag probes
  `api.tools.get('create_goal', agent)`, finds it, and delivers to the agent.
  **What that cost:** an operator decision was requested, five times, for a
  capability that was already present. A capability may be supplied by a bundle
  row, a profile patch, or a preset; all three planes must be checked before this
  host is declared to lack one.
- The goal service and its round driver are enabled, so goals exist and
  auto-continue once created.
- Resolved by the orchestrator on 2026-10-07, acting on "proceed autonomously":
  the plugin keeps the name **`dsh-jev-layer`**; **`navigate.stage` is dropped**
  from the roadmap, because it is the one module that needs a real UI (~76 KB,
  mostly TSX) and none of the operator's five use cases requires it — it can
  return as a separate plugin if a need appears. **Enabling the `tool-goal` row was
  left as an operator decision and turns out to be a decision that does not exist:**
  the preset supplies the tool, the web bundle keeps its own row disabled by
  design, and nothing is pending.
