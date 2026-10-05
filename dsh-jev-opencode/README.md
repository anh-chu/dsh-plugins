# dsh-jev-opencode

Mounts [`dsh-jev-prune`](https://github.com/yangyu666/dsh-jev-prune) with an **OpenCode**
model as its judge backend, so the semantic pruning layers work without a TypeSafe key.

## Why a wrapper is needed

`dsh-jev-prune` reads its verdicts from a `JevClient` that POSTs

```
POST <baseUrl>
authorization: Bearer <key>
{ model, state, questions: { <id>: { type: "noul", instructions: "..." } } }
```

and reads back `answers[<id>].noul`. Its replacement points — `deps.judge`
(`index.js:568`) and `fetchImpl` (`jev.js:148`) — are function parameters, not config
keys, and Cordis only ever passes `(ctx, config)`. So a different backend cannot be
selected from `cordis.yml`; it has to be injected by a wrapper that Cordis can mount.

This package does exactly that: it re-exports the plugin's own `Config` and forwards an
OpenCode-backed judge into `deps.judge`. The plugin's pruning logic is untouched.

## Backend

| | |
|---|---|
| Endpoint | `https://opencode.ai/zen/go/v1/chat/completions` |
| Model | `deepseek-v4-flash` (override with `model:`) |
| Credential | `~/.local/share/opencode/auth.json` → `opencode-go.key` (or `apiKey:`) |

Two things the raw endpoint requires or gets wrong, handled in `judge.mjs`:

- **`x-opencode-session` header.** OpenCode Go rejects requests without it
  (`400 MissingSessionID`). A process-stable UUID is sent.
- **Clamping.** These models sometimes answer with a count — a `400` for a 400-line file —
  instead of a probability. The plugin tests only `Number.isFinite` (`jev.js:274`), so an
  out-of-range value would silently mis-rank pruning. Values are clamped to `(0,1)` here.

Also note `max_tokens: 4000`: `deepseek-v4-flash` emits a long `reasoning_content` billed
against `max_tokens`, and at 400 the budget was consumed before `content` was written,
returning an empty string.

## The free Zen tier does not work here

`https://opencode.ai/zen/v1` returns `403 FreeTierError: OpenCode's free tier can only be
used from within OpenCode`. Only the **Go** route serves external clients. So the free
models listed in the profile's `opencode` provider (`muse-spark-*`, `nemotron-*`,
`mimo-*`) are not usable as a judge; the Go route's models are.

## Verification

```bash
node check.mjs   # unit checks over clamping/parsing/transport, fake fetch, no key needed
node pilot.mjs   # live: 5 runs over 5 questions on the real endpoint
```

Pilot result (5 runs, 5 questions, 25 values):

- 25/25 values in range, none at the 0/1 boundary
- max run-to-run spread 0.20
- semantically correct: the test-failure result scored 0.02–0.05 (must not prune),
  the duplicated read scored 0.95–0.99

That is a **pilot, not a calibration study.** Thresholds (`keepThreshold: 0.5`) are only as
good as the probabilities behind them; if you start depending on this, draw a reliability
curve over labelled decisions before trusting the ordering.

## Install

```bash
dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-jev-opencode
```

Then mount it **in place of** `dsh-jev-prune` in
`~/.dsh/.agent-presets/standard-jev/agent.cordis.yml`, inside the existing `compaction`
isolate group:

```yaml
    - id: jev-prune
      name: dsh-jev-opencode
      config:
        model: deepseek-v4-flash
```

Restart the DSH host afterwards. Confirm with the plugin's own status tool in a session
(`jev_prune_status`) and by checking the host log for the `[jev-opencode] judging via ...`
line.