# dsh-jev-layer

One decision layer for DeepSeek Harness, built on the Jev (System One) model.
It replaces three overlapping third-party plugins with a single plugin and a
single core: one judge client, one budget, one ledger, one settings page, and
exactly one module acting on any given hook.

Every module is **off on a fresh install**. The autopilot's answer module starts
in **shadow**, which records what it would have done and acts on nothing.

## What it does

| Module | What it decides |
|---|---|
| `admit.output` | Keeps the task-relevant parts of `read`, `grep`, `glob`, `web_fetch` and `web_search` results above a token threshold |
| `admit.terminal` | The same for `bash` and `pwsh` output, which the other plugin refused to touch on purpose: keeps failures, summaries, named and slow tests, drops ordinary passing detail |
| `screen.fetch` | Flags instructions aimed at the model inside fetched page text |
| `select.skill` | Picks at most one skill per turn from a catalog of fifteen or more |
| `gate.completion` | The `jev_gate` tool checks claims against the evidence you hand it. `checkFinalAnswer`, the automatic check of the final answer, exists and is tested, but no host seam calls it yet, so it does not run on its own |
| `tools.ask` | The `jev_ask` tool: typed `noul`, `choice` and `score` questions in, probabilities out |
| `supervise.goal` | One notice after a run of rounds without progress |
| `remind.drift` | One notice per repeated unproductive pattern |
| `guide.instructions` | One notice when the applicable rules are missing |
| `answer.questions` | Answers the agent's own questions when nobody is coming, or delegates |
| `notify.decline` | Tells you when it declined, so an unattended loop does not wait forever |
| `nag.nogoal` | Tells whoever can act that the session has no goal |
| `tools.surface` | Reduces the visible tool set — off by default, at most one change per session |
| `rank.files` | Ranks path candidates to steer the next read |
| `route.interjection` | Queues a running correction for the next step |
| `approve.workspace` | Returns `ask` for an eligible escalation instead of letting it through |
| `guide.shared` | Delivers a correction to exactly the agents this session already sent a finding to, reading its own `send_message` history for the recipient map |

## Install

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-jev-layer/packages/plugin
```

Use `link:`, not `file:`. A `file:` install hard-links existing files but does
not carry new ones, so adding a module leaves the installed barrel importing a
file that is not there and the next host start fails. `link:` symlinks the
package, so the installed copy is always the source tree. The cost is that
mid-edit code is live at the next start, so run the gates before restarting.

Then enable modules in **Settings → Plugins → dsh-jev-layer**. Each module has its
own switch and starts off.

## Configure the judge

The endpoint and model are settings, never constants. The default is TypeSafe's
route; a compatible System One route works with the same credential, for example
`https://opencode.ai/zen/v1/systemone` with model `jev-1.13-free`. The API key is
read from the DSH credential store through `ctx.get('credentials')`; the plugin
never holds a key of its own and never writes one to a file.

## Read what it did

Set `ledgerPath` to a JSONL file and every judgment is appended there: the
question, the probabilities, the threshold, the decision, and — in shadow mode —
what would have happened instead. Leave it empty and the ledger lives in memory,
which is fine while a host is running (the status route shows it) but gone when
the process exits. Set it before you rely on shadow mode, because the point of
shadow is to compare recorded decisions against your own answers later.

## Verify

```sh
node scripts/gates.mjs            # every gate, including the live ones
node scripts/gates.mjs --skip-live
node --test 'packages/**/test/*.test.js'
```

A gate is an assert script that exercises the real artifact and prints one unique
marker last. `GATES-ALL-PASS` means every marker printed. The live gates install
into a throwaway profile, start a real server on a spare port, and clean up.

## Safety properties the code enforces

- **One owner per hook.** The registry registers the listener and dispatches to
  the enabled modules that claim the seam. Exclusive seams partition by declared
  targets; two owners whose targets intersect fail startup naming both. Broadcast
  seams accept many observers and none may rewrite the event.
- **Nothing acts in shadow.** Every acting module checks the mode first and
  records what it would have done.
- **A broken module is off, not fatal.** Modules start lazily inside their own
  `try/catch` after `apply()` returns, so one failure does not take the plugin
  down.
- **Per-agent state is owned and disposed per module**, because unloading a plugin
  does not dispose `agent.ctx` registrations by itself.
- **A module that consumes no harness event declares `seam: null`**, so the plugin
  never registers a listener that cannot fire. Two modules work this way: they hear
  the autopilot's decision on the core's own channel instead.
- **The ledger is a cache.** The session log is the only source of truth, so the
  ledger can be rebuilt.

## Documents

- `SPEC.md` — intended behaviour, acceptance criteria, and what is out of scope.
- `TICKETS.md` — coverage items, tickets, gates, and a verification record per wave.
- `docs/CONTRACT.md` — the frozen interfaces, the seam classes, and the file
  ownership that let several agents work at once.
- `docs/PLAN-RECORD-wave-*.md` — what each wave was for, what shipped, why, and
  what was deliberately left out.

## Known limitations

- **Parity with the plugin this replaced is stub-level.** It compares decisions
  given identical judge answers, read-only, not a live side-by-side.
- **`packages/plugin/package.json` names the core through an absolute `file:`
  path.** It is what makes a `file:` install work: pnpm copies the plugin, so a
  sibling directory is invisible and a relative spec cannot resolve. Publishing
  would need the core bundled into the plugin or published as its own package.
- **`tools.surface` costs prompt-cache hits.** Changing the visible tool set
  rewrites the schemas inside the prompt prefix. That is why it is off by default
  and limited to one change per session.
- **The nag reaches the agent on this host, not you.** The web bundle disables the
  `tool-goal` row on purpose — its comment says presets own the model-facing tool —
  and the active preset (`standard-jev`) declares it, so agents have `create_goal`
  and `auto` delivers the nag to the agent. An earlier revision of this file asked
  the operator to enable that row; the decision did not exist.
