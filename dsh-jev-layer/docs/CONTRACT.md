# Frozen contract: dsh-jev-layer

This file is read-only for every implementer. It exists so that several agents
can work at once without inventing different interfaces. If something here is
wrong, stop and report it; do not change it silently.

Read `SPEC.md` for intent and `TICKETS.md` for tickets, CIDs and gates. This file
only fixes the interfaces.

## File ownership

Nobody edits a file another agent owns. Report instead.

| Owner | Files |
|---|---|
| frozen (nobody) | `docs/CONTRACT.md`, `packages/plugin/src/seams.js`, `packages/plugin/src/modules/index.js`, every `package.json`, `packages/plugin/cordis.patch.yml`, `SPEC.md`, `TICKETS.md` |
| core agent | `packages/core/**`, `scripts/gate-t2-*.mjs`, `scripts/gate-t3-*.mjs`, `scripts/gate-t4-*.mjs` |
| lifecycle agent | `packages/plugin/src/registry.js`, `packages/plugin/src/index.js`, `packages/plugin/src/config.js`, `packages/plugin/test/**`, `scripts/gate-t1-*.mjs`, `scripts/gate-t5-*.mjs` |
| one module agent per module | `packages/plugin/src/modules/<file>.js`, `scripts/gate-<ticket>.mjs`, optionally `packages/plugin/test/<id>.test.js` |
| integration agent | `scripts/gates.mjs`, `scripts/gate-live.mjs`, `scripts/gate-t12-parity.mjs`, and it may repair anything |

## Language and tooling

Plain ESM JavaScript. No TypeScript, no build step, no runtime dependencies.
`node --check <file>` must pass. Tests use `node --test`. Node 24 is installed;
`pnpm` is available for the workspace but no ticket needs it.

## The core API

`packages/core/src/index.js` exports one factory. The core imports nothing from
`@deepseek-ai/*` and touches no filesystem path unless given one.

```js
export function createCore(options) -> Core
```

`options`: `{ settings, fetchImpl?, now?, log?, statePath? }`
- `settings` — a reader with `get(key)` returning an already-unwrapped value.
  Never read a raw config object directly: a volatile field arrives as an object
  with `get()`, not a bare value, and comparing it silently fails.
- `fetchImpl` — injected for tests. Defaults to `globalThis.fetch`.
- `now` — injected clock, milliseconds. Defaults to `Date.now`.

`Core`:
- `judge.configured` — boolean.
- `judge.lastError` — `null` or `{ kind, ... }`, never thrown.
- `judge.ask(state, questions, opts) -> Promise<answers|null>`. `opts` is
  `{ featureId, timeoutMs?, failOpen }`. `failOpen` names what "do nothing" means
  for that call site. Never throws; returns `null` on every failure.
- `limiter.run(fn) -> Promise<T>` — one shared serialized lane for all calls,
  with 429/529 backoff honouring `Retry-After`.
- `budget.beginTurn()`, `budget.tryAcquire(featureId, units) -> boolean`,
  `budget.remaining(featureId) -> number`. Priority is explicit: the answering
  feature outranks pruning features when the ceiling is exhausted.
- `ledger.append(record)`, `ledger.read(featureId, callId?) -> record[]`,
  `ledger.rebuild(events) -> record[]`. A record is
  `{ featureId, callId, question, probabilities, threshold, decision, wouldBe,
  reason, mode, at }`. `reason` is a short string or null, and it exists because
  five modules pass one and the ledger used to drop it silently.
- `shadow.isShadow(featureId) -> boolean`.
- `notice.request({ kind, priority, text, tag, dedupeKey })` returns
  `'accepted'` or `'suppressed'`; `notice.drain() -> notice[]`.
  `kind` is `'blocked' | 'advisory'`; `blocked` outranks `advisory`.
- `notifications.send(text, meta) -> Promise<'sent'|'suppressed'|'failed'>`.
- `events.publish(name, payload) -> void` and
  `events.subscribe(name, fn) -> unsubscribe`, an in-process channel with **no
  harness involvement**. It exists so one module can react to another's decision
  without observing that module's harness seam and without importing its
  internals. The only name in use in wave 3 is
  `SEAMS.INTERNAL_QUESTION_EVALUATED` (`question/evaluated`), published by
  `answer.questions` at the moment it decides to delegate, with payload
  `{ callId, outcome, reason, question, options, at }`. `nag.nogoal` subscribes to
  it and reads the detail from the payload and the ledger. A subscriber whose
  publisher is disabled simply never fires: that is a declared soft dependency,
  not a failure, and the composition warns when the nag is enabled while its
  trigger module is off.

## The module descriptor

Each file in `packages/plugin/src/modules/` default-exports:

```js
export default {
  id: 'admit.output',        // stable: config key, ledger key, shadow key, notice tag
  seam: SEAMS.TOOLS_POST_EXECUTE,  // or null: consumes no harness event at all (observers only)
  seamClass: 'exclusive',     // 'exclusive' (default) or 'broadcast'; see Seam classes
  targets: ['read', 'grep'],  // required for exclusive transforming modules; ignored for broadcast
  settings: {                 // declarative; the registry builds the schema
    minTokens: { type: 'number', default: 2000, description: '...' },
  },
  start(api) {},              // optional; may be async
  stop() {},                  // optional; must release everything start registered
  handle(event, api) {},      // called for each event on this module's seam
};
```

`settings` types: `boolean`, `number`, `string`, `stringArray`. Every one becomes
a volatile field. The registry namespaces them, so the module reads its own key
directly through `api.config.get('minTokens')`.

The registry, not the module, calls `ctx.on(seam, ...)`. A module must never call
`ctx.on` itself for its seam.

## Seam classes

Every seam has a class, and every module declares which class it expects. This is
what replaced the original "one owner per seam, always" rule, which could not
express two observers on one event.

| Class | Rule | Seams |
|---|---|---|
| `exclusive` (default) | The module transforms or rewrites the event, and declares the `targets` it handles. Two enabled owners on one seam whose target sets intersect is a startup error naming both; owners with disjoint targets coexist on the seam, because each returns the event unchanged for a target it does not own | `tools/post-execute`, `tools/pre-execute`, `user-questions/request` |
| `broadcast` | The module observes only and must return the event unchanged, or `undefined` for an emit seam. Any number of enabled owners | `tools/result`, `agent/created`, `agent/pre-step` |

Why: the harness declares `tools/result` as an emit whose listener returns
`undefined`, so observers cannot disagree; and `agent/pre-step` is a waterfall
whose observers must return `next()` unchanged. A module that needs to *rewrite*
an `agent/pre-step` decision is not allowed as a broadcast observer and must take
an exclusive seam of its own.

Recorded conflict and its resolution: `select.skill` owns `agent/pre-step`, and
wave 2's `supervise.goal`, `remind.drift` and `guide.instructions` all observe the
same event. They are all broadcast observers and none may rewrite the decision.
`route.interjection` rewrites, so it must not be a broadcast observer on
`agent/pre-step`; it stays in wave 4 with an exclusive seam or a queue-only
re-scope.

## The module context (`api`)

Passed to `start` and `handle`:

```js
{
  id,                       // this module's id
  config: { get(key) },     // this module's own settings, volatile-unwrapped
  judge, budget, ledger, shadow, notice, notifications, log,   // from Core
  events,                   // the core's own channel between modules; no harness seam needed
  goals: { get(agent) },    // the goal view, or undefined when the session has none
  skills,                   // host service: the skill catalog, read per event
  tools,                    // host service: the tool surface, `register` only
  agents: { get(id), list() },  // the live agent registry, resolved lazily
  inject(agent, message),   // -> boolean: model-facing context for one agent
  registerAgent(agent, setup),  // -> disposer
  seams: SEAMS,
}
```

`registerAgent(agent, setup)` is the only way a module registers per-agent work. It
runs `setup(agentCtx)` inside the agent's own context, so the agent's scope owns
the teardown; the registry keeps the disposer keyed by agent too, because
unloading a plugin does not dispose an agent's registrations by itself. A module
that keeps per-agent state must use it and must not leak state between agents.

Two members reach an agent without registering anything on it. `agents` is the
live registry (`get(id)`, `list()`), resolved lazily so a host without the service
answers `undefined` and `[]` instead of throwing. `inject(agent, message)`
delivers model-facing context through the agent's own `inject` and returns false
when the agent cannot take a message, so a caller records a failure instead of
assuming success. A module that delivers builds the message itself and carries its
own source kind and `form: 'notice'`.

This list is the frozen surface. A member added to `apiFor` without a line here is
a contract defect, not an extension: `agents` and `inject` were added for
`guide.shared` and left undeclared, and an independent review found it.

## Seams

`packages/plugin/src/seams.js` is the single source of truth for names. Do not
write a seam string literal anywhere else.

Events a module may receive on its seam are the harness payloads for that event,
unchanged. A module that transforms a result returns the new value; a module that
only observes returns `undefined`.

## Gates

Every gate is `scripts/gate-<id>.mjs`, run from the repo root with plain `node`.
It exercises the real artifact named by its outcome, then prints exactly one
unique marker line as its last output, and exits non-zero if any assertion fails.
Assertions use `node:assert/strict`. No test framework, no snapshot files.

A gate must leave a known positive control for any absence check: prove the
detector fires on the case where the thing exists before asserting it is absent
for the case where it does not.

A gate that drives session history must replay it the way the host does:
append-only, with every earlier message still present on every step. A fixture
that prunes history to the one message it cares about cannot see a defect that
depends on the pruned part — `gate-t24-shared.mjs` passed for exactly that reason
while the module injected corrections that reversed earlier ones.

## Rules that are easy to get wrong

1. `apply()` must return before any module starts. Modules start lazily, each in
   its own `try/catch`. A throw during `apply()` fails the whole loader entry and
   takes every feature offline.
2. A disabled module registers nothing at all, including no listener and no
   per-agent state. Prove it by test, not by intent.
3. Fail-open is per call site. A pruning failure keeps everything; an answering
   failure delegates to the human. Pass the right `failOpen` for the module.
4. Shadow mode records the decision and performs no action. Every acting module
   checks `shadow.isShadow(id)` before acting.
5. Any injected notice carries the module's own source kind and `form: 'notice'`.
   An unlabelled context renders as a user prompt in derived history.
6. Config reads go through the resolver. A volatile field is an object with
   `get()`, not a value.
7. Do not add a session event type. The Session refuses an unknown stored type
   unless the envelope carries `ignorable: true`, which `append()` cannot set.
8. `@deepseek-ai/schemastery` may not resolve when the plugin is installed by a
   `file:` link. Import it in a `try/catch` with a `null` fallback and degrade to
   "no schema" without failing: the plugin's other behaviour must still work.
