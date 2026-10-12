/**
 * The shipped module list, checked statically.
 *
 * SPEC.md ("Testing decisions") asks for exactly this: "The registry's
 * one-owner-per-seam rule is a static test over the module list, not a runtime
 * hope." The registry enforces the rule at startup; this gate proves the shipped
 * list satisfies it before anything is mounted, and that each real module file
 * imports and default-exports the descriptor docs/CONTRACT.md fixes.
 *
 * The rule is the one in docs/CONTRACT.md "Seam classes", and it is target
 * aware: an `exclusive` module transforms the event and declares the `targets`
 * it handles, two enabled exclusive owners on one seam whose target sets
 * intersect are a startup error, and owners with disjoint targets coexist.
 * A `broadcast` module observes only, so any number of them may share a seam.
 * An exclusive module that declares no targets claims the whole seam.
 *
 * Positive control: the same detector is run over deliberately bad lists and
 * must report the intersecting pair, accept the disjoint pair and accept the
 * broadcast pair. A check that cannot fail proves nothing.
 */

import assert from 'node:assert/strict';
import { SEAMS } from '../packages/plugin/src/seams.js';
import MODULES from '../packages/plugin/src/modules/index.js';

/** Seams the harness declares `emit`; the compatibility default for a module
 * that declares no class, exactly as `registry.js` reads it. */
const SHARED_SEAMS = new Set([SEAMS.TOOLS_RESULT, SEAMS.AGENT_CREATED]);

/** Every shipped module id: wave 1 plus wave 2, from SPEC.md's tables. */
const SHIPPED = [
  'admit.output',
  'screen.fetch',
  'select.skill',
  'gate.completion',
  'tools.ask',
  'admit.terminal',
  'supervise.goal',
  'remind.drift',
  'guide.instructions',
  'answer.questions',
  'nag.nogoal',
  'notify.decline',
  'tools.surface',
  'rank.files',
  'route.interjection',
  'approve.workspace',
  'guide.shared',
];

const KNOWN_SEAMS = new Set(Object.values(SEAMS));

/** One descriptor must have a stable id, a real seam and a handler. */
function descriptorProblem(module, index) {
  if (module === null || typeof module !== 'object') return `module #${index} is not an object`;
  if (typeof module.id !== 'string' || module.id === '') return `module #${index} has no string id`;
  // `seam: null` is legal: the module consumes no harness event, so the registry
  // registers no listener for it. Any other seam must be a known name.
  if (module.seam !== null && (typeof module.seam !== 'string' || module.seam === '')) {
    return `module "${module.id}" has a seam that is neither a known name nor null`;
  }
  if (module.seam !== null && !KNOWN_SEAMS.has(module.seam)) {
    return `module "${module.id}" claims unknown seam "${module.seam}"`;
  }
  if (module.seamClass !== undefined && module.seamClass !== 'exclusive' && module.seamClass !== 'broadcast') {
    return `module "${module.id}" declares unknown seamClass "${String(module.seamClass)}"`;
  }
  if (typeof module.handle !== 'function') return `module "${module.id}" has no handle function`;
  return null;
}

/** The class a module runs as: a declared class, else the seam's emit default. */
function classOf(module) {
  return module.seamClass ?? (SHARED_SEAMS.has(module.seam) ? 'broadcast' : 'exclusive');
}

/** The targets an exclusive module handles, or `null` for the whole seam. */
function targetsOf(module) {
  if (!Array.isArray(module.targets)) return null;
  return new Set(module.targets.filter((target) => typeof target === 'string' && target !== ''));
}

/** Whether two target sets share a target. An undeclared set claims everything. */
function intersects(a, b) {
  if (a === null || b === null) return true;
  for (const target of a) if (b.has(target)) return true;
  return false;
}

/** Two enabled exclusive owners on one seam whose targets intersect. */
function seamConflicts(modules) {
  const claimed = new Map();
  const conflicts = [];
  for (const module of modules) {
    if (classOf(module) === 'broadcast') continue;
    const mine = targetsOf(module);
    const owners = claimed.get(module.seam) ?? [];
    for (const owner of owners) {
      if (!intersects(mine, owner.targets)) continue;
      conflicts.push(
        `seam "${module.seam}" is claimed by two modules with intersecting targets: `
        + `"${owner.id}" and "${module.id}"`,
      );
    }
    owners.push({ id: module.id, targets: mine });
    claimed.set(module.seam, owners);
  }
  return conflicts;
}

// ── the nine real files import and carry a descriptor ────────────────────
assert.ok(Array.isArray(MODULES), 'modules/index.js default-exports an array');
assert.equal(MODULES.length, SHIPPED.length, `the shipped list has ${SHIPPED.length} modules`);

for (const [index, module] of MODULES.entries()) {
  const problem = descriptorProblem(module, index);
  assert.equal(problem, null, problem ?? '');
}

assert.deepEqual(
  MODULES.map((module) => module.id).sort(),
  [...SHIPPED].sort(),
  'the list is exactly the shipped modules',
);

// Re-import each file by its own path, so a barrel that re-exports a different
// object than the file default-exports cannot pass.
for (const id of SHIPPED) {
  const file = `../packages/plugin/src/modules/${id.replace('.', '-')}.js`;
  const loaded = await import(file);
  assert.ok(loaded.default, `${file} has a default export`);
  assert.equal(loaded.default.id, id, `${file} default-exports "${id}"`);
  assert.equal(typeof loaded.default.handle, 'function', `${id} has a handle`);
  assert.ok(
    MODULES.some((module) => module === loaded.default),
    `modules/index.js lists the object ${file} default-exports`,
  );
}

// ── positive controls: the detector discriminates on all three shapes ────
const exclusive = (id, targets) => ({
  id, seam: SEAMS.TOOLS_POST_EXECUTE, seamClass: 'exclusive', targets, handle: () => {},
});
const broadcastOn = (id, seam) => ({ id, seam, seamClass: 'broadcast', handle: () => {} });

const fired = seamConflicts([exclusive('a', ['grep']), exclusive('b', ['grep', 'read'])]);
assert.equal(fired.length, 1, 'the detector reports two owners with an intersecting target');
assert.match(fired[0], /"a"/);
assert.match(fired[0], /"b"/);
assert.match(fired[0], /tools\/post-execute/);

assert.deepEqual(
  seamConflicts([exclusive('a', ['read']), exclusive('b', ['bash'])]),
  [],
  'disjoint targets on one exclusive seam are not a conflict',
);
// An undeclared target set claims the whole seam, so it conflicts with a
// declared owner and with another undeclared owner. Both must fire.
assert.equal(
  seamConflicts([exclusive('a', ['read']), { id: 'b', seam: SEAMS.TOOLS_POST_EXECUTE, handle: () => {} }]).length,
  1,
  'an undeclared target set claims the whole seam, so it conflicts with a declared owner',
);
assert.equal(
  seamConflicts([
    { id: 'a', seam: SEAMS.TOOLS_POST_EXECUTE, handle: () => {} },
    { id: 'b', seam: SEAMS.TOOLS_POST_EXECUTE, handle: () => {} },
  ]).length,
  1,
  'two undeclared exclusive owners on one seam still conflict',
);
assert.deepEqual(
  seamConflicts([
    broadcastOn('a', SEAMS.AGENT_PRE_STEP),
    broadcastOn('b', SEAMS.AGENT_PRE_STEP),
    broadcastOn('c', SEAMS.AGENT_PRE_STEP),
  ]),
  [],
  'a broadcast seam holds several observers without a conflict',
);
assert.deepEqual(
  seamConflicts([broadcastOn('a', SEAMS.TOOLS_RESULT), broadcastOn('b', SEAMS.TOOLS_RESULT)]),
  [],
  'an emit seam with no declared class is broadcast by default',
);

// ── the shipped list satisfies the rule ─────────────────────────────────
assert.deepEqual(seamConflicts(MODULES), [], 'no two enabled modules claim one exclusive seam with intersecting targets');

// The one shared exclusive seam is the terminal/output split; state it as a
// property, not an accident, because that disjointness is what CID-18 rests on.
const output = MODULES.find((module) => module.id === 'admit.output');
const terminal = MODULES.find((module) => module.id === 'admit.terminal');
assert.equal(classOf(output), 'exclusive', 'admit.output transforms');
assert.equal(classOf(terminal), 'exclusive', 'admit.terminal transforms');
assert.equal(
  intersects(targetsOf(output), targetsOf(terminal)),
  false,
  'admit.output and admit.terminal declare disjoint tool targets',
);

const owners = new Map();
for (const module of MODULES) {
  // A module with no seam owns no seam: it hears the decision on the core channel.
  if (module.seam === null) continue;
  owners.set(module.seam, [...(owners.get(module.seam) ?? []), module.id]);
}
assert.deepEqual(
  [...owners].map(([seam, ids]) => `${seam}: ${[...ids].sort().join(', ')}`).sort(),
  [
    'agent/created: tools.surface',
    'agent/pre-step: guide.instructions, guide.shared, remind.drift, route.interjection, select.skill, supervise.goal',
    'tools/post-execute: admit.output, admit.terminal',
    'tools/pre-execute: approve.workspace',
    'tools/result: gate.completion, rank.files, screen.fetch, tools.ask',
    'user-questions/request: answer.questions',
  ],
  'every seam has exactly the owners the SPEC assigns it',
);

console.log('GATE-MODULES-OK');
