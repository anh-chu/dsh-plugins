/**
 * In-process event channel for the core.
 *
 * Why this exists rather than a harness seam: `answer.questions` owns
 * `user-questions/request` exclusively, and the nag must react to that module's
 * decision at the moment it makes it. Observing the same harness seam would make
 * the nag a second owner of it (docs/CONTRACT.md, seam classes). This channel is
 * deliberately not a harness facility: nothing is persisted, nothing crosses the
 * process, and a name with no subscriber is a no-op rather than an error.
 *
 * The session log stays the only source of truth (practices.md principle 1), so
 * nothing published here may become state a later decision depends on. A
 * subscriber that misses an event must be able to read the same fact from the
 * ledger.
 *
 * @module dsh-jev-layer-core/events
 */

/**
 * Create the channel.
 *
 * @param {{ log?: { warn?: Function } }} [options]
 * @returns {{ publish: (name: string, payload?: unknown) => number, subscribe: (name: string, fn: Function) => () => void, subscribers: (name?: string) => number }}
 */
export function createEvents({ log } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const byName = new Map();

  /**
   * Subscribe to a name.
   *
   * @param {string} name
   * @param {Function} fn
   * @returns {() => void} idempotent unsubscribe
   */
  function subscribe(name, fn) {
    if (typeof name !== 'string' || name.length === 0) return () => {};
    if (typeof fn !== 'function') return () => {};
    let set = byName.get(name);
    if (set === undefined) {
      set = new Set();
      byName.set(name, set);
    }
    set.add(fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(fn);
      if (set.size === 0) byName.delete(name);
    };
  }

  /**
   * Publish to every current subscriber, synchronously, in subscription order.
   *
   * A subscriber that throws is logged and skipped: the publisher is in the
   * middle of a decision and must not fail because a listener is broken.
   *
   * @param {string} name
   * @param {unknown} [payload]
   * @returns {number} how many subscribers were delivered to
   */
  function publish(name, payload) {
    const set = byName.get(name);
    if (set === undefined || set.size === 0) return 0;
    let delivered = 0;
    for (const fn of [...set]) {
      try {
        fn(payload);
        delivered += 1;
      } catch (error) {
        log?.warn?.(`[dsh-jev-layer] subscriber for "${name}" threw: ${error?.message ?? error}`);
      }
    }
    return delivered;
  }

  /**
   * @param {string} [name] omit for the total
   * @returns {number}
   */
  function subscribers(name) {
    if (name === undefined) {
      let total = 0;
      for (const set of byName.values()) total += set.size;
      return total;
    }
    return byName.get(name)?.size ?? 0;
  }

  return { publish, subscribe, subscribers };
}

export default createEvents;
