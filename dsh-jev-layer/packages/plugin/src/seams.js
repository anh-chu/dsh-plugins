/**
 * Frozen seam names. This is the single source of truth: no other file may write
 * a seam string literal.
 *
 * Harness event names below were verified against DSH 0.2.0-rc.2 (tools/pre-execute,
 * tools/post-execute, tools/result, agent/created, agent/pre-step and
 * user-questions/request all appear in practices.md and in the installed types).
 * AGENT_INJECT is a method, not an event: notices go through the core arbiter and
 * are delivered with agent.inject().
 *
 * The one exception to the read-only rule: the selection module may correct
 * SKILL_CATALOG, and must report the exact change with its evidence. Every other
 * name here is fixed.
 */
export const SEAMS = Object.freeze({
  // Harness events, consumed through the registry's single listener per seam.
  TOOLS_POST_EXECUTE: 'tools/post-execute',
  TOOLS_RESULT: 'tools/result',
  TOOLS_PRE_EXECUTE: 'tools/pre-execute',
  AGENT_CREATED: 'agent/created',
  AGENT_PRE_STEP: 'agent/pre-step',
  USER_QUESTIONS_REQUEST: 'user-questions/request',

  // Not events. Listed so that no module invents its own name for them.
  AGENT_INJECT: 'agent/inject',
  TOOLS_PRESENT: 'tools/present',

  // Corrected by the selection module (T8) from the placeholder 'skill/catalog',
  // which names no event on 0.2.0-rc.2. The skill catalog is assembled on
  // `agent/pre-step`:
  //   - the host Event catalog has no `skill/catalog`; the only skills event is
  //     `skills/change`, an unfiltered invalidation emit that carries no payload;
  //   - `@deepseek-ai/dsh-tool-skill` snapshots the session catalog inside its
  //     `agent/pre-step` waterfall (lib/index.js; README: "At each eligible
  //     agent/pre-step, the plugin snapshots the calling session's skill catalog");
  //   - the parity baseline `dsh-jev-tools` 0.1.13 registers its skill-suggestion
  //     listener on `agent/pre-step` too.
  // The value therefore equals AGENT_PRE_STEP by design: one event, two named
  // roles.
  SKILL_CATALOG: 'agent/pre-step',

  // Plugin-internal. Published by the core, never by the harness. Used by the
  // nag in wave 3 so that it does not become a second owner of
  // user-questions/request.
  INTERNAL_QUESTION_EVALUATED: 'question/evaluated',
});
