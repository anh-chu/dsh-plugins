/**
 * The per-turn judgment budget.
 *
 * One shared ceiling bounds what a turn may spend, and each feature has its own
 * sub-budget so one noisy capability cannot eat the turn. Priority is explicit
 * and lives in the table below: the answering feature outranks every pruning
 * feature, because an unanswered question blocks the agent while a missed prune
 * only costs tokens.
 *
 * The reservation is what makes that ordering real rather than aspirational.
 * Each turn, the priority features' sub-budgets are set aside out of the
 * ceiling; pruning draws only from what is left. So when the shared pool is
 * exhausted, a pruning acquire fails while the answering feature still has its
 * reservation.
 *
 * @module dsh-jev-layer-core/budget
 */
import {
  DEFAULT_PRIORITY_BUDGET,
  DEFAULT_TURN_CEILING,
  PRIORITY_FEATURES,
  SETTING_KEYS,
  readNumber,
} from './settings.js';

/**
 * Create the budget tracker.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @param {() => void} [deps.onTurnStart] called on every `beginTurn()`.
 * @returns {object} the budget.
 */
export function createBudget(deps) {
  const { settings } = deps;
  const usedByFeature = new Map();
  let usedTotal = 0;

  /** The shared per-turn ceiling, re-read so a settings write needs no restart. */
  function ceiling() {
    return Math.max(0, readNumber(settings, SETTING_KEYS.turnCeiling, DEFAULT_TURN_CEILING));
  }

  /**
   * The declared priority of a feature.
   *
   * @param {string} featureId the feature id.
   * @returns {number} the priority; 0 means "pruning class".
   */
  function priority(featureId) {
    const configured = readNumber(settings, SETTING_KEYS.featurePriority(featureId), NaN);
    if (Number.isFinite(configured)) return configured;
    return PRIORITY_FEATURES[featureId] ?? 0;
  }

  /**
   * The per-feature sub-budget.
   *
   * An unset pruning sub-budget means "no extra cap beyond the shared pool",
   * which is what keeps the ceiling the only bound a single pruning feature
   * needs. A priority feature always has a real one, because it is the reserve.
   */
  function subBudget(featureId) {
    const fallback = priority(featureId) > 0 ? DEFAULT_PRIORITY_BUDGET : ceiling();
    return Math.max(0, readNumber(settings, SETTING_KEYS.featureBudget(featureId), fallback));
  }

  /** Units set aside this turn for the priority features. */
  function reserved() {
    let sum = 0;
    for (const id of Object.keys(PRIORITY_FEATURES)) {
      if (priority(id) > 0) sum += subBudget(id);
    }
    return sum;
  }

  /** What a pruning feature may draw from: the ceiling minus the reservation. */
  function sharedPool() {
    return Math.max(0, ceiling() - reserved());
  }

  /**
   * How many more units a feature could take right now.
   *
   * @param {string} featureId the feature id.
   * @returns {number} the effective remaining units for that feature.
   */
  function remaining(featureId) {
    const used = usedByFeature.get(featureId) ?? 0;
    const ownRoom = subBudget(featureId) - used;
    const sharedRoom = priority(featureId) > 0 ? ceiling() - usedTotal : sharedPool() - usedTotal;
    return Math.max(0, Math.min(ownRoom, sharedRoom));
  }

  /**
   * Try to take units from the turn budget.
   *
   * @param {string} featureId the feature id.
   * @param {number} [units] the units to take; defaults to 1.
   * @returns {boolean} whether the units were granted.
   */
  function tryAcquire(featureId, units = 1) {
    if (!Number.isFinite(units) || units <= 0) return false;
    if (remaining(featureId) < units) return false;
    usedByFeature.set(featureId, (usedByFeature.get(featureId) ?? 0) + units);
    usedTotal += units;
    return true;
  }

  /** Start a new turn: reset the counters and close the previous notice turn. */
  function beginTurn() {
    usedTotal = 0;
    usedByFeature.clear();
    deps.onTurnStart?.();
  }

  return {
    beginTurn,
    tryAcquire,
    remaining,
    priority,
    subBudget,
    /** Test seam: the shared ceiling is a setting, not a constant. */
    ceiling,
  };
}
