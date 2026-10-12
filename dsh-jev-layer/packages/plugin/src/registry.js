/**
 * The registry: the only place that knows the module list, and the only place
 * that calls `ctx.on`.
 *
 * Why the registry owns the seam listeners. A harness hook may have several
 * features that want it, and two independent owners produce an outcome that
 * depends on registration order — the failure this plugin exists to remove. So
 * the registry registers exactly one listener per seam and dispatches, in
 * registration order, to every enabled owner of that seam. Two enabled owners
 * whose work is not disjoint is a startup error that names both ids, not a
 * silent precedence rule.
 *
 * Lifecycle rules, each from docs/CONTRACT.md:
 *
 *   1. `apply()` returns before any module starts. `start()` is called from the
 *      deferred boot, and every module starts in its own `try/catch`: a broken
 *      feature degrades to "off" instead of taking the other features offline.
 *   2. A disabled module registers nothing, including no listener and no
 *      per-agent state. Listeners are registered lazily, only for a seam that
 *      has at least one started module, and disposed when the last one stops.
 *   3. Disabling a module runs its disposers: its `stop()` and every per-agent
 *      registration it made through `api.registerAgent`.
 *
 * Every seam has a class, and every module declares which class it expects
 * (`seamClass`), plus the `targets` an exclusive transformer handles.
 *
 *   - `exclusive` (the default) — the module transforms the event, and two
 *     enabled owners on one seam whose target sets intersect is a startup error
 *     naming both. Owners with disjoint targets coexist, because each returns
 *     the event unchanged for a target it does not own.
 *   - `broadcast` — the module observes only and must return the event
 *     unchanged (or `undefined` for an emit seam). Any number of enabled owners.
 *
 * An undeclared module keeps the class its seam had before descriptors carried
 * one: the harness's two `emit` seams below are broadcast, every other seam is
 * exclusive. A declared class always wins.
 */

import { SEAMS } from './seams.js';
import { createModuleConfig, isModuleEnabled, readConfig } from './config.js';
import { createDelivery } from './delivery.js';

/**
 * Seams many modules may claim at once, because the registry fans out per id.
 *
 * These two are the harness's own `emit` events. They are the compatibility
 * default for a module that declares no class: `tools/result` is declared
 * `(exec, result) => undefined` (dsh-tools `lib/types/index.d.ts`), so two
 * observers cannot disagree, and `agent/created` keeps per-agent state.
 */
const LEGACY_BROADCAST_SEAMS = new Set([SEAMS.AGENT_CREATED, SEAMS.TOOLS_RESULT]);

/**
 * Seams whose payload is the pair `(exec, result)`, in any dispatch mode.
 *
 * `tools/result` is an emit and arrives as that pair with no continuation;
 * `tools/post-execute` is a waterfall and arrives as the same pair followed by
 * `next`. Both are packed identically, because the harness's `next` accepts the
 * result unchanged and never carries it.
 */
const RESULT_PAIR_SEAMS = new Set([SEAMS.TOOLS_POST_EXECUTE, SEAMS.TOOLS_RESULT]);

/** Every legal seam name. A module that invents one is a startup error. */
const KNOWN_SEAMS = new Set(Object.values(SEAMS));

/** The two classes docs/CONTRACT.md fixes. Any other value is a descriptor bug. */
const SEAM_CLASSES = new Set(['exclusive', 'broadcast']);

const NOOP = () => {};

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The class a seam runs as when a module declares none. */
function classOfSeam(seam) {
  // A module with no seam consumes no harness event at all: it works through the
  // core's own channel or registers per agent, so it can only ever observe.
  if (seam === null || seam === undefined) return 'broadcast';
  return LEGACY_BROADCAST_SEAMS.has(seam) ? 'broadcast' : 'exclusive';
}

/** The class one module runs as. A declared class wins over the seam default. */
function classOfModule(module) {
  return module?.seamClass ?? classOfSeam(module?.seam);
}

/**
 * The targets an exclusive module handles, as a set, or `null` when it declares
 * none. `null` means "the whole seam": it intersects every other target set, so
 * two undeclared owners on one exclusive seam still conflict. That is the
 * pre-T21 behaviour and the conservative reading of an incomplete descriptor.
 */
function targetsOf(module) {
  if (!Array.isArray(module?.targets)) return null;
  return new Set(module.targets.filter((target) => typeof target === 'string' && target !== ''));
}

/** Whether two target sets share a target. An undeclared set claims everything. */
function intersects(a, b) {
  if (a === null || b === null) return true;
  for (const target of a) if (b.has(target)) return true;
  return false;
}

/**
 * @param {object} options
 * @param {Array<object>} options.modules module descriptors
 * @param {object} options.ctx Cordis context
 * @param {object} [options.config] the loader's config object (volatile fields inside)
 * @param {object} [options.core] the core built by packages/core
 */
export function createRegistry({ modules, ctx, config, core, settleMs }) {
  const byId = new Map();
  const states = new Map();
  /** Normalised target sets per module; `null` is the whole seam. */
  const targets = new Map();
  const problems = [];
  /** Ids that must not be retried until the user changes their switch. */
  const failed = new Set();  const agentRegs = new Map();
  const apis = new Map();
  const listeners = new Map();

  let live = config ?? {};
  let running = false;
  let fatal = null;

  const log = core?.log ?? ctx?.logger ?? null;
  const warn = typeof log?.warn === 'function' ? log.warn.bind(log) : NOOP;
  /**
   * Observer work the harness does not wait for. `tools/result` is an emit: the harness
   * calls each listener and drops the returned promise, so a module that judges a result
   * (a slow request) finishes after the next step has already begun. The step wrapper
   * settles this set before it drains notices, or the notice is raised for a step that is
   * already past and is audited as `turn-ended` instead of reaching the model.
   */
  const inflight = new Set();
  const settle = () => (inflight.size === 0 ? undefined : Promise.allSettled([...inflight]));
  const delivery = createDelivery({ core, warn, settle, settleMs });

  // ── validate the list once, at creation ────────────────────────────────
  for (const [index, module] of (Array.isArray(modules) ? modules : []).entries()) {
    const id = module?.id;
    if (typeof id !== 'string' || id.length === 0) {
      problems.push(`module #${index} has no id`);
      continue;
    }
    if (byId.has(id)) {
      problems.push(`duplicate module id "${id}"`);
      continue;
    }
    // `seam: null` is legal and means "this module consumes no harness event":
    // it reacts through the core's own channel or registers per agent. Such a
    // module only observes, so claiming to be exclusive is a contradiction.
    const observesOnly = module?.seam === null || module?.seam === undefined;
    if (!observesOnly && !KNOWN_SEAMS.has(module.seam)) {
      problems.push(`module "${id}" claims unknown seam "${String(module.seam)}"`);
    }
    if (observesOnly && module?.seamClass === 'exclusive') {
      problems.push(
        `module "${id}" declares no seam but claims to be exclusive; a module with no seam only observes`,
      );
    }
    if (module.seamClass !== undefined && !SEAM_CLASSES.has(module.seamClass)) {
      problems.push(`module "${id}" declares unknown seamClass "${String(module.seamClass)}"`);
    }
    const seamClass = classOfModule(module);
    byId.set(id, module);
    targets.set(id, targetsOf(module));
    states.set(id, {
      id,
      seam: module.seam,
      seamClass,
      targets: seamClass === 'exclusive' && Array.isArray(module.targets) ? [...module.targets] : null,
      configured: false,
      enabled: false,
      started: false,
      error: null,
    });
  }

  // ── configuration ──────────────────────────────────────────────────────

  /** Fold the current config's switches into the states. Absent means off. */
  function syncEnabled() {
    for (const state of states.values()) {
      const configured = isModuleEnabled(live, state.id);
      if (configured === state.configured) continue;
      state.configured = configured;
      // A switch that actually changed is an explicit instruction: clear the
      // failure so the module gets one more attempt.
      failed.delete(state.id);
      state.enabled = configured;
    }
  }

  /**
   * Whether a seam runs as `broadcast`. A declared `broadcast` on any module of
   * the seam wins; an undeclared seam keeps the pre-T21 emit default.
   */
  function isBroadcast(seam) {
    for (const state of states.values()) {
      if (state.seam === seam && state.seamClass === 'broadcast') return true;
    }
    return false;
  }

  /**
   * A started owner of the same exclusive seam whose targets intersect, or
   * `null`. Disjoint owners coexist, so this replaces the old single-owner rule.
   */
  function conflictingOwner(state) {
    if (isBroadcast(state.seam)) return null;
    const mine = targets.get(state.id) ?? null;
    for (const other of states.values()) {
      if (other.id === state.id || !other.started || other.seam !== state.seam) continue;
      if (intersects(mine, targets.get(other.id) ?? null)) return other.id;
    }
    return null;
  }

  /**
   * Enabled modules that cannot run: a missing id, a duplicate, an unknown seam,
   * an unknown seamClass, or two enabled exclusive owners on one seam whose
   * target sets intersect.
   */
  function enabledConflicts() {
    const conflicts = [];
    for (const problem of problems) conflicts.push(problem);
    const claimed = new Map();
    for (const state of states.values()) {
      if (!state.enabled) continue;
      if (isBroadcast(state.seam)) continue;
      const mine = targets.get(state.id) ?? null;
      const owners = claimed.get(state.seam) ?? [];
      for (const owner of owners) {
        if (!intersects(mine, owner.targets)) continue;
        conflicts.push(
          `seam "${state.seam}" is claimed by two enabled modules with intersecting targets: `
          + `"${owner.id}" and "${state.id}"`,
        );
      }
      owners.push({ id: state.id, targets: mine });
      claimed.set(state.seam, owners);
    }
    return conflicts;
  }

  // ── module api ─────────────────────────────────────────────────────────

  /**
   * The `tools` service, or `null` when this host has none.
   *
   * `ctx.get('tools')` is tried first. It is not always ready when the registry
   * builds a module api, so a deferred registration through `ctx.inject` is the
   * fallback — the same pattern the installed `dsh-jev-router` uses for
   * `webServer`. The returned disposer works in both cases: it releases the
   * registration if one happened and cancels it if one has not happened yet.
   */
  function toolsBridge() {
    const direct = ctx?.get?.('tools');
    if (direct && typeof direct.register === 'function') return direct;
    if (typeof ctx?.inject !== 'function') return null;
    return {
      register(definition) {
        let release = null;
        let cancelled = false;
        try {
          ctx.inject(['tools'], (scoped) => {
            if (cancelled) return;
            const released = scoped?.tools?.register?.(definition);
            release = typeof released === 'function' ? released : null;
          });
        } catch (error) {
          warn(`[dsh-jev-layer] could not reach the tools service: ${messageOf(error)}`);
          return null;
        }
        return () => {
          cancelled = true;
          const released = release;
          release = null;
          if (typeof released === 'function') released();
        };
      },
    };
  }

  /**
   * The goal service, for the autonomy gate.
   *
   * `ctx.goals.get(agent)` is a projection that carries `phase` and
   * `activation`; `undefined` means there is no goal at all, which is a
   * different fact from a goal that is paused or disarmed. The service may
   * mount after this plugin, so it is re-read on every call rather than bound
   * once, and a host without it returns `undefined` instead of throwing.
   */
  /**
   * The live agent registry.
   *
   * One module, `guide.shared`, has to deliver to an agent other than the one it
   * is handed; everything else reaches only its own agent. `ctx.agents` is
   * registered by `@deepseek-ai/dsh-agent` and exposes `get(id)` and `list()`.
   * Both are read-only, both tolerate a host without the service, and neither
   * throws: a missing registry means "no other agent", which is a fact the
   * caller can act on.
   */
  function agentsBridge() {
    let resolved;
    function service() {
      if (resolved) return resolved;
      try {
        resolved = ctx?.get?.('agents');
      } catch {
        resolved = undefined;
      }
      return resolved;
    }
    return {
      get(id) {
        const agents = service();
        if (!agents || typeof agents.get !== 'function') return undefined;
        try {
          return agents.get(id);
        } catch (error) {
          warn(`[dsh-jev-layer] the agents service threw on get: ${messageOf(error)}`);
          return undefined;
        }
      },
      list() {
        const agents = service();
        if (!agents || typeof agents.list !== 'function') return [];
        try {
          const all = agents.list();
          return Array.isArray(all) ? all : [];
        } catch (error) {
          warn(`[dsh-jev-layer] the agents service threw on list: ${messageOf(error)}`);
          return [];
        }
      },
    };
  }

  function goalsBridge() {    let resolved;
    function service() {
      if (resolved) return resolved;
      try {
        resolved = ctx?.get?.('goals');
      } catch {
        resolved = undefined;
      }
      return resolved;
    }
    return {
      get(agent) {
        const goals = service();
        if (!goals || typeof goals.get !== 'function') return undefined;
        try {
          return goals.get(agent);
        } catch (error) {
          warn(`[dsh-jev-layer] the goals service threw for module "${'goals'}": ${messageOf(error)}`);
          return undefined;
        }
      },
    };
  }

  function apiFor(id) {
    const cached = apis.get(id);
    if (cached) return cached;
    const api = {
      id,
      config: createModuleConfig(() => live, id),
      judge: core?.judge,
      budget: core?.budget,
      ledger: core?.ledger,
      shadow: core?.shadow,
      notice: core?.notice,
      notifications: core?.notifications,
      /**
       * The in-process event channel, so one module can react to another's
       * decision without observing that module's exclusive harness seam.
       * See docs/CONTRACT.md and ticket T25.
       */
      events: core?.events,
      /**
       * The goal service, for the autonomy gate: `api.goals.get(agent)` returns
       * the view or `undefined` when the session has no goal.
       */
      goals: goalsBridge(),
      /**
       * The live agent registry, for the one module that must reach an agent
       * other than the current one. `ctx.agents` is registered by
       * `@deepseek-ai/dsh-agent` (`lib/index.js`, `super(ctx, "agents")`) and
       * exposes `get(id)` and `list()`. Resolved lazily, because the service may
       * mount later and a host without it must return nothing rather than throw.
       */
      agents: agentsBridge(),
      /**
       * Deliver model-facing context to one agent, through the agent's own
       * `inject`, which queues context for the next admitted step without
       * waking the driver. The caller builds the message and carries its own
       * source kind and `form: 'notice'`. Returns false when the agent cannot
       * take a message, so the caller records a failure instead of assuming.
       */
      inject(agent, message) {
        if (typeof agent?.inject !== 'function') return false;
        try {
          agent.inject(message);
          return true;
        } catch (error) {
          warn(`[dsh-jev-layer] inject failed for module "${id}": ${messageOf(error)}`);
          return false;
        }
      },
      log,
      seams: SEAMS,
      /**
       * The tool surface, for the two modules that provide a model-invoked tool.
       *
       * The frozen module api does not name a tool channel, and this package must
       * not reach for `@deepseek-ai/*` itself. The service is resolved here, from
       * the host context, and the module only ever sees `register`.
       */
      tools: toolsBridge(),
      /**
       * The skill catalog, for `select.skill`.
       *
       * The host service is `ctx.get('skills')` — `@deepseek-ai/dsh-skill`
       * registers it under that name (`lib/index.js`, `super(ctx, "skills")`),
       * and `@deepseek-ai/dsh-tool-skill` consumes it as `ctx.skills.list()`
       * (`lib/index.js`, its `inject` list and its catalog call). It is not
       * always mounted when a module starts, so this is a getter: `select.skill`
       * accepts an object or a function and reads it per event, which is what
       * lets a service that mounts later still be seen.
       */
      skills: skillsBridge(),
      /**
       * The host's sandbox policy service, for `approve.workspace`.
       *
       * That module only handles an escalation from `workspace-write`, and the mode is
       * read from `resolve({ session })` here. Nothing handed the service over, so on a
       * real turn the mode was always unknown, every call was "not eligible", and the
       * module never acted and never recorded why.
       */
      sandboxPolicy: sandboxPolicyBridge(),
      /**
       * The only way a module registers per-agent work. The setup runs inside
       * the agent's own context, so the agent's scope owns the teardown; the
       * registry keeps the disposer as well, because unloading the plugin does
       * not dispose an agent's registrations by itself. Reaching an agent
       * WITHOUT registering on it is `agents` and `inject` above.
       */
      registerAgent(agent, setup) {
        return registerAgent(id, agent, setup);
      },
    };
    apis.set(id, api);
    return api;
  }

  /**
   * The skills service, or a getter that yields it once the host mounts it.
   *
   * A host with no such service is not an error: the getter returns `undefined`
   * and the module reads that as "no catalog", exactly as it reads an absent
   * `api.skills`. Nothing here throws, because a module start that throws takes
   * the module off.
   */
  function skillsBridge() {
    const read = () => {
      try {
        const service = ctx?.get?.('skills');
        return service && typeof service.list === 'function' ? service : undefined;
      } catch {
        return undefined;
      }
    };
    const direct = read();
    if (direct !== undefined) return direct;
    // No host context to ask again: say so once, rather than wrap nothing.
    if (typeof ctx?.get !== 'function') return undefined;
    return read;
  }

  /**
   * The host `sandboxPolicy` service, or `undefined` when it is not mounted.
   *
   * `apiFor` runs on every dispatch, so a service that mounts after the module started
   * is read fresh on the next call; no getter is needed.
   */
  function sandboxPolicyBridge() {
    try {
      const service = ctx?.get?.('sandboxPolicy');
      return service && typeof service.resolve === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The skills service a module api resolves right now, or `undefined`.
   *
   * The registry's public surface uses the same unwrap a module does — a
   * `skills` holder may be the service or a getter — so the live gate can
   * observe the exact resolution the module gets.
   */
  function skillsService() {
    const holder = skillsBridge();
    const service = typeof holder === 'function' ? holder() : holder;
    return service !== undefined && typeof service.list === 'function' ? service : undefined;
  }

  function registerAgent(id, agent, setup) {
    const scope = agent?.ctx;
    if (!scope || typeof scope.effect !== 'function' || typeof setup !== 'function') return NOOP;
    const agentKey = agent?.id ?? agent;
    let dispose = NOOP;
    try {
      dispose = scope.effect(() => {
        const teardown = setup(scope);
        return () => {
          if (typeof teardown === 'function') teardown();
        };
      }, `${id}: per-agent registration`);
    } catch (error) {
      warn(`[dsh-jev-layer] module "${id}" could not register per-agent behaviour: ${messageOf(error)}`);
      return NOOP;
    }
    const stop = typeof dispose === 'function' ? dispose : NOOP;

    let done = false;
    register(id, agentKey, stop);
    return () => {
      if (done) return;
      done = true;
      unregister(id, agentKey, stop);
      safe(stop);
    };
  }

  function register(id, agentKey, stop) {
    let perAgent = agentRegs.get(id);
    if (!perAgent) {
      perAgent = new Map();
      agentRegs.set(id, perAgent);
    }
    let set = perAgent.get(agentKey);
    if (!set) {
      set = new Set();
      perAgent.set(agentKey, set);
    }
    set.add(stop);
  }

  function unregister(id, agentKey, stop) {
    const set = agentRegs.get(id)?.get(agentKey);
    if (!set) return;
    set.delete(stop);
    if (set.size === 0) agentRegs.get(id).delete(agentKey);
  }

  /** Run and forget every per-agent registration a module made. */
  function disposeAgentRegistrations(id) {
    const perAgent = agentRegs.get(id);
    if (!perAgent) return 0;
    let ran = 0;
    for (const set of perAgent.values()) {
      for (const stop of set) {
        ran += 1;
        safe(stop);
      }
    }
    perAgent.clear();
    return ran;
  }

  function safe(fn) {
    try {
      fn?.();
    } catch (error) {
      warn(`[dsh-jev-layer] a disposer threw: ${messageOf(error)}`);
    }
  }

  // ── seams ──────────────────────────────────────────────────────────────

  function wantedSeams() {
    const seams = new Set();
    for (const state of states.values()) {
      // A null seam means no harness listener: registering `ctx.on(null, ...)`
      // would be a never-firing listener, which is what this avoids.
      if (state.started && state.seam !== null && state.seam !== undefined) seams.add(state.seam);
    }
    // Turn boundaries and notice delivery ride on `agent/pre-step` (see delivery.js).
    // Only a module that spends the turn budget or raises a notice needs them, so the
    // hook is added for those and a module that does neither registers nothing extra.
    for (const state of states.values()) {
      if (state.started && byId.get(state.id)?.needsTurn === true) {
        seams.add(SEAMS.AGENT_PRE_STEP);
        break;
      }
    }
    return seams;
  }

  /** One listener per seam, registered lazily and disposed when it has no owner. */
  function syncListeners() {
    const wanted = wantedSeams();
    for (const [seam, dispose] of [...listeners]) {
      if (wanted.has(seam)) continue;
      listeners.delete(seam);
      safe(dispose);
    }
    for (const seam of wanted) {
      if (listeners.has(seam)) continue;
      try {
        const dispose = ctx.on(seam, (...args) => dispatch(seam, ...args));
        listeners.set(seam, typeof dispose === 'function' ? dispose : NOOP);
      } catch (error) {
        warn(`[dsh-jev-layer] could not listen on "${seam}": ${messageOf(error)}`);
      }
    }
  }

  function ownersOf(seam) {
    const owners = [];
    for (const state of states.values()) if (state.started && state.seam === seam) owners.push(state.id);
    return owners;
  }

  function dispatch(seam, ...args) {
    const next = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    // Seams whose payload is the pair `(exec, result)` are packed, and whether a
    // `next` continuation is present must NOT change that. `tools/post-execute` is
    // a waterfall the harness calls as `(exec, result, next)`, and its inner `next`
    // accepts the result unchanged — so a module that does not receive `result` has
    // nothing to act on and cannot recover it. Packing only when `next` was absent
    // left both post-execute modules inert in a live host, while every gate stayed
    // green because the gates call `handle` with the packed shape themselves.
    // A single payload argument stays bare: `agent/pre-step` and the question seam
    // pass one object, and `tools/pre-execute` passes the exec alone.
    const pair = args.length >= 2 && args[1] !== undefined && RESULT_PAIR_SEAMS.has(seam);
    const event = pair ? { exec: args[0], result: args[1] } : args[0];
    const owners = ownersOf(seam);
    const route = (continuation) => {
      if (owners.length === 0) return typeof continuation === 'function' ? continuation() : undefined;
      if (isBroadcast(seam)) return runBroadcast(seam, owners, event, continuation);
      return runChain(owners, event, continuation);
    };
    // The step wrapper sees the harness's own decision, so it must be outermost.
    if (seam === SEAMS.AGENT_PRE_STEP && typeof next === 'function') {
      return delivery.run(event, () => route(next));
    }
    const running = route(next);
    if (seam === SEAMS.TOOLS_RESULT && running && typeof running.then === 'function') {
      inflight.add(running);
      const done = () => inflight.delete(running);
      running.then(done, done);
    }
    return running;
  }

  /**
   * Broadcast owners observe only. Each is called with the event and no
   * continuation, in registration order, so none can consume or rewrite the
   * decision. Their returns are discarded on a waterfall seam — a return that is
   * neither `undefined` nor the event itself is a descriptor bug and is warned
   * about, because `docs/CONTRACT.md` lets an observer hand the event back
   * unchanged — and the downstream decision is handed back unchanged. An emit
   * seam has no decision to make, so its single listener returns the observers'
   * own (ignored) output.
   */
  async function runBroadcast(seam, owners, event, next) {
    for (const id of owners) {
      const out = await runHandle(id, event, undefined);
      if (out !== undefined && out !== event) {
        warn(`[dsh-jev-layer] broadcast observer "${id}" returned a value on "${seam}"; it is ignored`);
      }
    }
    // An emit seam has no decision to make, so the listener returns nothing. What
    // an observer returned is never handed back: on an emit seam the harness
    // ignores it anyway, and letting it travel would give a caller a value it must
    // not act on.
    return typeof next === 'function' ? next() : undefined;
  }

  /**
   * Exclusive owners on one seam with disjoint targets form a chain: each is
   * offered the continuation that runs the owners after it, and the last runs
   * the harness's own `next`. An owner that does not handle the event returns it
   * unchanged, so the owners after it still run. A single owner behaves exactly
   * as it did before target sets existed.
   */
  function runChain(owners, event, next) {
    const [id, ...rest] = owners;
    const continuation = rest.length === 0 ? next : () => runChain(rest, event, next);
    return runHandle(id, event, continuation);
  }

  /**
   * Turn a module's answer into what a waterfall seam accepts.
   *
   * A module handed the packed `{exec, result}` pair answers in the packed form —
   * the whole result with `content` rebuilt — because that is the contract. The
   * harness's `tools/post-execute` waterfall wants a `PostToolDecision` instead, and
   * rejects a result-shaped value with "accept decision cannot replace both value
   * and content". Passing it through left every pruning module failing in enforce
   * mode on a real turn: the call errored and the model saw an error string, not
   * the log. Gates never saw it because they called `handle` directly and read the
   * packed value. The conversion lives here, once, so no module has to know which
   * of the two shapes its caller wants.
   *
   * Only a result-shaped answer (no `kind`, a `content` array) is converted; a
   * decision, `undefined` and anything else pass through untouched.
   */
  function asDecision(out, isWaterfall) {
    if (!isWaterfall || out === null || typeof out !== 'object') return out;
    if (typeof out.kind === 'string' || !Array.isArray(out.content)) return out;
    return {
      kind: 'accept',
      content: out.content,
      ...(Array.isArray(out.additionalContexts) && out.additionalContexts.length > 0
        ? { additionalContexts: out.additionalContexts }
        : {}),
    };
  }

  async function runHandle(id, event, next) {
    const module = byId.get(id);
    const state = states.get(id);
    // A waterfall `next` must run exactly once, whether the module calls it or
    // the registry does after an observer returned nothing.
    let called = false;
    // What the continuation itself rejected with. That error belongs to the harness
    // (the human path aborted, no answerer is mounted, a later owner denied), not to this
    // module, so it travels back unchanged. Swallowing it returned `undefined` from the
    // waterfall, and the harness read that as an answer: a delegated question that the
    // human path refused reached the model as "Cannot read properties of undefined
    // (reading 'answers')" instead of the harness's own "no answerer accepted the request".
    let downstream;
    const guarded = typeof next === 'function' ? () => {
      if (called) return undefined;
      called = true;
      let outcome;
      try {
        outcome = next();
      } catch (error) {
        downstream = { error };
        throw error;
      }
      if (outcome && typeof outcome.then === 'function') {
        return outcome.then(undefined, (error) => {
          downstream = { error };
          throw error;
        });
      }
      return outcome;
    } : undefined;
    try {
      const out = await module?.handle?.(event, apiFor(id), guarded);
      if (out === undefined && typeof guarded === 'function' && !called) return await guarded();
      return asDecision(out, typeof guarded === 'function');
    } catch (error) {
      if (downstream !== undefined && downstream.error === error) throw error;
      // A throwing module must not break the hook for the harness or for the
      // other modules. Fail open, and record it.
      state.error = messageOf(error);
      warn(`[dsh-jev-layer] module "${id}" threw while handling "${state.seam}": ${state.error}`);
      if (typeof guarded === 'function' && !called) {
        return await guarded();
      }
      return undefined;
    }
  }

  // ── module lifecycle ───────────────────────────────────────────────────

  function recordOff(id, error) {
    const ledger = core?.ledger;
    if (typeof ledger?.append !== 'function') return;
    try {
      ledger.append({
        featureId: id,
        callId: '',
        question: null,
        probabilities: {},
        threshold: null,
        decision: 'off',
        wouldBe: 'none',
        mode: readConfig(live, 'mode', 'shadow') ?? 'shadow',
        at: Date.now(),
        error,
      });
    } catch {
      // The ledger is a derived cache; a failure to record must not cascade.
    }
  }

  async function startModule(id) {
    const module = byId.get(id);
    const state = states.get(id);
    try {
      if (typeof module.start === 'function') await module.start(apiFor(id));
      state.started = true;
      state.error = null;
    } catch (error) {
      state.started = false;
      state.enabled = false;
      state.error = messageOf(error);
      failed.add(id);
      disposeAgentRegistrations(id);
      recordOff(id, state.error);
      warn(`[dsh-jev-layer] module "${id}" failed to start and is off: ${state.error}`);
    }
  }

  async function stopModule(id) {
    const module = byId.get(id);
    try {
      if (typeof module?.stop === 'function') await module.stop();
    } catch (error) {
      warn(`[dsh-jev-layer] module "${id}" threw while stopping: ${messageOf(error)}`);
    } finally {
      disposeAgentRegistrations(id);
      states.get(id).started = false;
    }
  }

  /** Bring the running set in line with the config, one module at a time. */
  async function reconcile() {
    syncEnabled();
    for (const state of states.values()) {
      if (state.started && !state.enabled) await stopModule(state.id);
    }
    for (const state of states.values()) {
      if (state.started || !state.enabled || failed.has(state.id)) continue;
      const owner = conflictingOwner(state);
      if (owner !== null) {
        // A runtime toggle into a target set another started owner already
        // handles is refused here, not at startup, because the two modules were
        // never enabled together. The module stays enabled but unstarted, so it
        // starts by itself once the owning module is switched off.
        const error = `seam "${state.seam}" is already owned by "${owner}"`;
        if (state.error !== error) warn(`[dsh-jev-layer] module "${state.id}" stays off: ${error}`);
        state.error = error;
        continue;
      }
      await startModule(state.id);
    }
    syncListeners();
  }

  // ── public surface ─────────────────────────────────────────────────────

  /**
   * Start every enabled module, lazily and in isolation.
   *
   * Rejects only when the configuration itself is impossible — an unknown seam,
   * a duplicate id, or two enabled owners on one exclusive seam. Nothing is
   * started in that case, and the error names every id involved. `apply()` has
   * already returned, so the loader entry stays active.
   */
  async function start() {
    if (!running) {
      running = true;
      syncEnabled();
      const conflicts = enabledConflicts();
      if (conflicts.length > 0) {
        fatal = new Error(`dsh-jev-layer cannot start: ${conflicts.join('; ')}`);
        for (const state of states.values()) {
          if (state.configured && !state.started) {
            state.error = state.error ?? 'not started: the module list is invalid';
            recordOff(state.id, state.error);
          }
        }
        throw fatal;
      }
      await reconcile();
    }
    return state();
  }

  async function stop() {
    for (const state of [...states.values()]) {
      if (state.started) await stopModule(state.id);
    }
    for (const state of states.values()) disposeAgentRegistrations(state.id);
    for (const [seam, dispose] of [...listeners]) {
      listeners.delete(seam);
      safe(dispose);
    }
    running = false;
    return state();
  }

  /**
   * Apply a new config object, or re-read the current one.
   *
   * `settings.update` writes through the volatile references in place, so the
   * no-argument form is what a settings event calls: the switches are read
   * again, and only the modules whose switch changed are started or stopped.
   */
  async function applyConfig(next) {
    if (next !== undefined && next !== null) live = next;
    if (!running) {
      syncEnabled();
      return state();
    }
    if (fatal) {
      // A refused composition stays refused. Without this, reconcile() would
      // start the first claimant in list order, silently undoing the refusal.
      syncEnabled();
      const remaining = enabledConflicts();
      if (remaining.length > 0) {
        fatal = new Error(`dsh-jev-layer cannot start: ${remaining.join('; ')}`);
        return state();
      }
      fatal = null;
    }
    await reconcile();
    return state();
  }

  function state() {
    return [...states.values()].map(({ id, seam, seamClass, targets, enabled, started, error }) => ({
      id,
      seam,
      seamClass,
      targets,
      enabled,
      started,
      error,
    }));
  }

  return { start, stop, applyConfig, state, skillsService };
}
