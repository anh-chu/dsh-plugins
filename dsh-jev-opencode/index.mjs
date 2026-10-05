// dsh-jev-opencode — mountable wrapper around dsh-jev-prune.
//
// Cordis calls apply(ctx, config) and never passes the third `deps` argument
// (dsh-jev-prune/index.js:568 is `apply(ctx, config, deps = {})`, and the
// comment there confirms "DSH 只传前两个参数"). Its default backend is a
// JevClient pointed at TypeSafe, which needs a TYPESAFE_API_KEY that this
// machine does not have.
//
// This wrapper re-exports the plugin's own `Config` schema and its tool set,
// but forwards an OpenCode-backed judge into `deps.judge`, so the plugin's
// pruning logic runs unchanged against a reachable model.
//
// Mount it in place of `dsh-jev-prune`:
//
//   - id: jev-prune
//     name: dsh-jev-opencode
//     config:
//       model: deepseek-v4-flash

import * as jevPrune from 'dsh-jev-prune'
import { OpenCodeJudge, OPENCODE_ENDPOINT, OPENCODE_MODEL } from './judge.mjs'

export const name = 'jev-opencode'
export const Config = jevPrune.Config
export { JEV_PRUNE_MARKER } from 'dsh-jev-prune'

/**
 * The plugin's `apply`, with `deps.judge` supplied.
 *
 * The judge is built lazily per apply so that reading the OpenCode auth store
 * happens at mount time, not import time — and so a missing key degrades to
 * the plugin's own "loaded but inert" path instead of throwing during load.
 */
export function apply(ctx, config = {}) {
  const wantedModel =
    typeof config.model === 'string' && config.model.length > 0 && config.model !== 'jev-latest'
      ? config.model
      : OPENCODE_MODEL

  let judge
  try {
    judge = new OpenCodeJudge({
      apiKey: typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined,
      endpoint: config.baseUrl ?? OPENCODE_ENDPOINT,
      model: wantedModel,
    })
  } catch (error) {
    ctx.logger?.warn?.(
      `[jev-opencode] no usable OpenCode credential (${error?.message ?? error}) — ` +
        'jev-prune loads but will not judge',
    )
    judge = undefined
  }

  if (judge !== undefined) {
    ctx.logger?.info?.(
      `[jev-opencode] judging via ${judge.endpoint} as "${judge.model}" ` +
        '(OpenCode Go requires the x-opencode-session header; it is sent)',
    )
  }

  return jevPrune.apply(ctx, config, { judge })
}