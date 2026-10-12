/**
 * tools.surface — reduce the presented tool set for one agent scope.
 *
 * `ctx.tools.restrict(filter)` removes global tool names from the surface one
 * agent scope sees. A restriction can only reduce: restrictions intersect, and
 * a tool the deployment does not provide can never be added. So "start narrow,
 * reveal later" is a sequence of restrictions being lifted, never an addition.
 *
 * Three facts shape everything below.
 *
 *   - **Every change rewrites the prompt prefix.** The presented tool schemas
 *     are part of the prompt, so each change invalidates the prompt cache for
 *     the session. The module therefore computes its filter once per session
 *     and changes the surface AT MOST ONCE by default (`maxChanges`); a second
 *     request in the same session is refused and recorded in the ledger. The
 *     module ships off.
 *   - **The agent's own scope owns the restriction.** The registration happens
 *     inside `api.registerAgent`, so `setup` receives the agent's context and
 *     `ctx.tools.restrict` there applies to that agent alone. The restriction
 *     disposer is returned from `setup`, which puts it under the agent scope's
 *     effect: disposing the registration lifts the restriction, and this
 *     module's `stop()` lifts everything again on toggle-off or unload.
 *   - **Fail open.** A missing tools service, an unknown tool name the service
 *     rejects, or any throw leaves the inherited surface intact and records the
 *     failure. A restriction is an optimisation of the prompt, never the reason
 *     a tool the agent needs is missing.
 *
 * Shadow mode (docs/CONTRACT.md rule 4) records the would-be restriction and
 * calls `restrict` not at all.
 *
 * The registry owns the seam listener. This module never calls `ctx.on`.
 *
 * @module dsh-jev-layer/modules/tools-surface
 */
import { SEAMS } from '../seams.js';

/** The feature id: config key, ledger key, shadow key, settings namespace. */
const FEATURE_ID = 'tools.surface';

/** One change per session unless the operator raises the budget. */
const DEFAULT_MAX_CHANGES = 1;

/** One message for a log line, whatever was thrown. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A settings list as a deduplicated list of non-empty names.
 *
 * @param {unknown} value the raw setting.
 * @returns {string[]} the usable names.
 */
function namesOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const name of value) {
    if (typeof name !== 'string' || name === '' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * A non-negative whole number, or the fallback when the setting is unusable.
 *
 * @param {unknown} value the raw setting.
 * @param {number} fallback the value to use when it is not a usable count.
 */
function countOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * The session a change belongs to.
 *
 * The agent id is the session key because `restrict` is per agent scope. An
 * agent without an id shares the conservative `agent` key, so two anonymous
 * agents cannot each spend a change budget.
 *
 * @param {object} agent the harness agent the event carried.
 * @returns {string} the session key.
 */
function sessionKeyOf(agent) {
  const id = agent?.id;
  return typeof id === 'string' && id !== '' ? id : 'agent';
}

/** Whether two name lists hold the same names. Order is not a change. */
function sameNames(left, right) {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((name) => b.includes(name));
}

/** Whether two filters ask for the same presented set. */
function sameFilter(a, b) {
  return a !== null && b !== null && sameNames(a.allow, b.allow) && sameNames(a.deny, b.deny);
}

/**
 * Wrap a disposer so it runs at most once.
 *
 * Two owners hold each restriction disposer: the agent scope's `effect`, which
 * the registry disposes, and this module's `disposeAll`. `stop()` reaches both
 * — it lifts the restrictions and then the registry unwinds the per-agent
 * registrations — so an unwrapped disposer would run twice per session.
 */
function runOnce(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * The module's working state, decidable from the frozen module api alone.
 *
 * A gate builds one against a synthetic api; the default descriptor below
 * builds one per `start()` and drives it from `agent/created`.
 *
 * @param {object} api the module context from docs/CONTRACT.md.
 * @returns {object} the surface: `install` and `disposeAll`.
 */
export function createToolsSurface(api) {
  /**
   * Session key -> `{ key, changes, filter, releases }`.
   *
   * `filter` is the set the session currently asks for and `changes` counts how
   * many times that set changed. `releases` holds one run-once disposer per
   * agent registration, because `agent/created` fires again on resume, clear
   * and compaction: each new agent is a new scope that needs its own
   * restriction, and the previous agent's scope is disposed separately.
   */
  const sessions = new Map();

  function warn(message) {
    try {
      api?.log?.warn?.(`[${FEATURE_ID}] ${message}`);
    } catch {
      // Logging must never become the failure.
    }
  }

  /** Whether the core is recording only. A shadow decision acts on nothing. */
  function shadowed() {
    try {
      return api?.shadow?.isShadow?.(FEATURE_ID) === true;
    } catch {
      return false;
    }
  }

  function mode() {
    return shadowed() ? 'shadow' : 'enforce';
  }

  function changeBudget() {
    return countOf(api?.config?.get?.('maxChanges'), DEFAULT_MAX_CHANGES);
  }

  /**
   * The filter the settings ask for, or `{}` when they ask for nothing.
   *
   * `allow` and `deny` may be used together; the service intersects them. An
   * empty filter is never handed to `restrict`, which rejects one.
   */
  function plannedFilter() {
    const allow = namesOf(api?.config?.get?.('allow'));
    const deny = namesOf(api?.config?.get?.('deny'));
    const filter = {};
    if (allow.length > 0) filter.allow = allow;
    if (deny.length > 0) filter.deny = deny;
    return filter;
  }

  /**
   * Append one decision to the ledger. The ledger is a cache; never fail for it.
   *
   * The core keeps exactly the nine keys docs/CONTRACT.md fixes, so the reason
   * travels inside `decision` — `refused:already-changed`, as `answer.questions`
   * writes `delegated:<gate>` — and the filter inside `question`. An extra field
   * would be dropped silently by `ledger.normalize`.
   */
  function record(session, decision, filter) {
    try {
      api?.ledger?.append?.({
        featureId: FEATURE_ID,
        callId: session,
        question: { filter: filter ?? null },
        probabilities: {},
        threshold: null,
        decision,
        wouldBe: 'restrict',
        mode: mode(),
        at: Date.now(),
      });
    } catch {
      // A ledger that is down must not change the tool surface.
    }
  }

  function sessionFor(key) {
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const session = { key, changes: 0, filter: null, releases: new Set() };
    sessions.set(key, session);
    return session;
  }

  /**
   * Reduce this session's tool surface, through the agent's own scope.
   *
   * The budget counts *changes of the set*, and only those: `agent/created`
   * fires again on resume, clear and compaction, and a new agent scope starts
   * with the inherited surface, so the same filter is applied again to every
   * new scope without spending the budget. Refusing that would hand the agent
   * back the tools the operator removed, and the restored set is itself a new
   * prompt prefix. A *different* filter is a change, and past the budget it is
   * refused and recorded.
   *
   * Every path that does not restrict is recorded, so the ledger explains the
   * outcome. The cap is checked before anything is registered, so a refused
   * request registers nothing at all, and the count moves only after `restrict`
   * returned a disposer, so a failed attempt does not spend the budget.
   *
   * @param {object} event the `agent/created` payload, or a bare agent.
   */
  function install(event) {
    const agent = event?.agent ?? event;
    const key = sessionKeyOf(agent);
    const session = sessionFor(key);

    if (agent === null || typeof agent !== 'object') {
      record(key, 'unavailable:no-agent', undefined);
      return;
    }
    const filter = plannedFilter();
    if (Object.keys(filter).length === 0) {
      // Nothing is asked for. This is not a decision, so it is not recorded.
      return;
    }
    const same = sameFilter(session.filter, filter);
    if (!same && session.changes >= changeBudget()) {
      record(key, 'refused:already-changed', filter);
      warn(
        `refused a second surface change for session "${key}": each change rewrites the prompt `
        + 'prefix and invalidates the prompt cache',
      );
      return;
    }
    if (typeof api?.registerAgent !== 'function') {
      record(key, 'unavailable:no-register-agent', filter);
      return;
    }
    if (shadowed()) {
      record(key, 'restrict', filter);
      return;
    }

    let installed = false;
    const dispose = api.registerAgent(agent, (agentCtx) => {
      // The agent's own scope is the only correct scope for `restrict`: a
      // restriction taken on the global scope would remove the tool from every
      // agent, and the frozen api exposes no such service anyway.
      const service = agentCtx?.tools;
      if (!service || typeof service.restrict !== 'function') {
        record(key, 'unavailable:no-tools-service', filter);
        return null;
      }
      let released = null;
      try {
        released = service.restrict(filter);
      } catch (error) {
        record(key, `error:${messageOf(error)}`, filter);
        return null;
      }
      const release = runOnce(() => {
        session.releases.delete(release);
        if (typeof released !== 'function') return;
        try {
          released();
        } catch (error) {
          warn(`a restriction disposer threw: ${messageOf(error)}`);
        }
      });
      session.releases.add(release);
      if (!same) session.changes += 1;
      session.filter = filter;
      installed = true;
      record(key, 'restrict', filter);
      return release;
    });

    if (!installed) {
      // Nothing was installed: release the registration rather than leave one
      // behind that does nothing.
      try {
        dispose?.();
      } catch (error) {
        warn(`could not release an unused registration: ${messageOf(error)}`);
      }
    }
  }

  /** Lift every restriction this module installed and forget its sessions. */
  function disposeAll() {
    for (const session of sessions.values()) {
      for (const release of [...session.releases]) release();
      session.releases.clear();
    }
    sessions.clear();
  }

  return { install, disposeAll };
}

/** The surface `start` built, released by `stop`. */
let surface = null;

export default {
  id: FEATURE_ID,
  description: 'Reduces the visible tool set - off by default, at most one change per session.',
  label: 'Limit the visible tools',
  seam: SEAMS.AGENT_CREATED,
  seamClass: 'broadcast',
  settings: {
    allow: {
      type: 'stringArray',
      default: [],
      description:
        'Tool names to keep, one per line: everything else is removed from the tools this agent '
        + 'is offered. tools.surface ships off by default, and the first change invalidates the '
        + 'prompt cache once.',
    },
    deny: {
      type: 'stringArray',
      default: [],
      description:
        'Tool names to remove from the tools this agent is offered. `allow` and `deny` may be '
        + 'used together and intersect. tools.surface ships off by default and changes the '
        + 'presented tool set at most once per session.',
    },
    maxChanges: {
      type: 'number',
      default: DEFAULT_MAX_CHANGES,
      description:
        'How many times tools.surface may change one session\'s tool set. The default is 1: a '
        + 'later request in the same session is refused and recorded, because every change '
        + 'rewrites the tool schemas in the prompt prefix and so invalidates the prompt cache. '
        + 'tools.surface ships off by default.',
    },
  },

  /** Build the surface for this start; a restart never keeps the old one. */
  start(api) {
    const previous = surface;
    surface = null;
    previous?.disposeAll();
    surface = createToolsSurface(api);
  },

  /** Release everything `start` registered, including every live restriction. */
  stop() {
    const current = surface;
    surface = null;
    current?.disposeAll();
  },

  /**
   * Observe one `agent/created` and reduce that agent's tool surface once.
   *
   * A broadcast observer returns `undefined` and never rewrites the event.
   */
  handle(event, api) {
    try {
      const current = surface ?? createToolsSurface(api);
      if (surface === null) surface = current;
      current.install(event);
    } catch (error) {
      // Advisory by construction: a surface failure keeps the inherited tools.
      try {
        api?.log?.warn?.(`[${FEATURE_ID}] no surface change was applied: ${messageOf(error)}`);
      } catch {
        // Logging must never become the failure.
      }
    }
    return undefined;
  },
};
