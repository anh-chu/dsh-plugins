# Plan record: dsh-jev-layer, wave 1

Written when wave 1's tickets closed, while the reasons were still known. This is
not a source of truth: `SPEC.md` and `TICKETS.md` are. It records why the code
looks the way it does, and what was deliberately left out.

## What the change was for

Three third-party Jev plugins and one draft each implemented part of a decision
layer around the Jev System One model, each with its own judge client, settings,
budget, ledger and failure mode. Running more than one put two judges on the same
hook: `dsh-jev-tools` prunes `grep` results while `luobosibing2/dsh-jev-plugin`
also rewrites tool results, so the outcome depended on registration order and the
judge was paid for twice. Neither of the other two mounted on DSH 0.2.0-rc.2 at
all, because both pin `@deepseek-ai/dsh*` peers to exactly `0.1.7-rc.2` and
`0.1.7-alpha.1`.

## What shipped

One plugin, `dsh-jev-layer`, on one framework-agnostic core, with a registry that
enforces one owner per seam and a module per capability, every module off on a
fresh install. Wave 1 is the core plus parity with the installed baseline:

- `packages/core` — judge client, shared limiter with 429/529 backoff, per-turn
  budget with explicit priority, rebuildable ledger, shadow mode, notice arbiter,
  notification transports.
- `packages/plugin` — config schema generated from module settings, the registry,
  the entry, the status/settings/probe routes.
- Five modules: `admit.output`, `screen.fetch`, `select.skill`,
  `gate.completion`, `tools.ask`.
- 21 gate scripts, 25 markers, all passing in the orchestrator's own run.

## Decisions and why

- **Plain ESM JavaScript, no build step, no runtime dependencies.** The core must
  be testable with no host and no network, and a build step would add a failure
  mode to every ticket and to every parallel agent.
- **The interface was frozen before the agents were dispatched.** Seven agents
  working from a prose spec would each invent their own idea of what
  `api.notice.request` returns. `docs/CONTRACT.md` plus a file-ownership table is
  what made the fan-out safe.
- **One owner per seam, enforced by the registry, not by convention.** The
  registry registers the listener and dispatches to the single enabled module that
  claims it; two enabled modules on one exclusive seam is a startup error naming
  both. This is what makes a union of three plugins safe.
- **`tools/result` is a broadcast seam.** The harness declares that event as an
  emit returning `undefined`, so several observers cannot disagree. Exclusive
  seams are for modules that transform or rewrite.
- **`screen.fetch` moved from `tools/post-execute` to `tools/result`** so that the
  transforming seam kept exactly one owner.
- **`select.skill` uses `agent/pre-step`.** The frozen `SKILL_CATALOG` name was a
  placeholder and was corrected with evidence: the host has no `skill/catalog`
  event, its only skills event is `skills/change`, and `dsh-tool-skill` assembles
  the catalog inside an `agent/pre-step` waterfall.
- **The credential is resolved through `ctx.get('credentials').resolve(ref)` with
  an environment fallback, awaited inside the deferred boot.** `apply()` still
  returns before anything runs; the key is cached and never logged, and only
  `{ ref, configured, source }` is exposed.
- **Modules are off on a fresh install and the default mode is shadow.** Nothing
  acts until an operator enables it and reads the ledger.

## What was deliberately excluded

- Real parity with `dsh-jev-tools`. T12 compares decisions given identical judge
  answers, read-only, against the installed entry points. It is not a live
  side-by-side and not identical prompts, and it is recorded as such.
- Memory gating: ranking Mnemosyne hygiene candidates and reranking recall. Those
  are script-level actions against the Mnemosyne CLI and need no plugin.
- `jev_search` from `dsh-jev-grep`. `admit.output` already owns `grep` output;
  line-level ranking is only worth revisiting if a measured comparison on one real
  flood shows it beats segment retention.
- Any UI beyond the status, settings and probe routes.
- Waves 2 to 4.

## Debt and known limits

- `packages/plugin/package.json` names the core through an absolute `file:` path,
  because a `file:` install copies the plugin and a relative path cannot resolve.
  That path is machine-specific and blocks publishing.
- `SKILL_CATALOG` now equals `AGENT_PRE_STEP`, so wave 2's `supervise.goal` and
  `route.interjection` collide with it under one-owner-per-seam and must be
  resolved when those modules are built.
- The judge gate needs network and a live credential, so it is not hermetic and it
  fails by design between credential rotation and re-storing the new value.
- Module gates drive a synthetic `api`, which is why five agents could work in
  parallel and also why they could not see a live credential that never resolved.
  CID-17 and gate G-T11-5 exist because of that, and the failure is recorded in
  `TICKETS.md` rather than smoothed over.
