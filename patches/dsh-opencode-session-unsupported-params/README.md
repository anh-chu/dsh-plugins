# dsh-opencode-session: 400 on `prompt_cache_retention` (and other unsupported params)

Upstream: `dsh-opencode-session` 0.1.1 (npm). Applied via pnpm `patchedDependencies`.

## Bug

`PI_CACHE_RETENTION=long` makes pi-ai add `prompt_cache_retention: "24h"` to every request. Some
OpenCode Go models (for example `glm-5.3-flash`) reject it:

    400 {"param":"prompt_cache_retention","type":"invalid_request_error","message":"... [unsupported_parameter] ... use \"prompt_cache_options\""}

DeepSeek models accept it, so a blanket strip would lose their 24h cache.

## Fix

The fetch wrapper learns per-model quirks instead of hard-coding model names:

1. Send the request as-is (models that accept the field keep it).
2. On `400` + "unsupported/unknown parameter" naming a field that is in the body, delete that field and
   retry (max 4 retries per request).
3. Remember `(model, field)` in `~/.dsh/opencode-quirks.json` and strip it up front next time.
   Entries never expire (a model id keeps its behaviour); delete an entry from the file to re-test it.

3b. **Protected fields** (`reasoning_effort`, `reasoning`, `thinking`) are never dropped or learned: the models
   support them. When OpenCode rejects one intermittently ("native reasoning control reasoning_effort is
   not allowed", seen mid-session on `glm-5.3-flash` while the same body succeeds on retry), the plugin
   retries with the field kept: once as-is, then once with a rotated `x-opencode-session` to reach
   another backend. A persistent 400 (3 sends) surfaces as the error.
4. **Startup probe:** about 20 s after start, send one 1-token request ("hi", `maxTokens: 1`) to each
   listed model that has never been probed, sequentially, through the normal stream path. A 400
   is learned by step 2 before any real turn. A model whose probe ends in an error is retried at the
   next start. Costs one tiny request per model, once. Disable with `probe: false`;
   change the delay with `probeDelayMs`.

Optional config on the `opencode-go-session-header` row: `bodyRules` (ordered
`{model: regex, drop: [...], keep: [...]}`, default none) and `quirksFile` (store path).
Only requests to `opencode.ai` are touched. The patch also adds a stable header for session-less
calls (mneme entity extraction), which was already in the local patch.

## Install

Copy `dsh-opencode-session@0.1.1.patch` to `<profile>/patches/` and add to `pnpm-workspace.yaml`:

    patchedDependencies:
      dsh-opencode-session@0.1.1: patches/dsh-opencode-session@0.1.1.patch

Then `pnpm install` (never mid-turn) and restart `dsh web`.

## Test

    node test/unsupported-params.test.mjs     # prints "all ok"; set PLUGIN_LIB to test another copy
