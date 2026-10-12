/**
 * T12 / G-T12-1 — parity with the installed `dsh-jev-tools` 0.1.13.
 *
 * ## What this compares
 *
 * One recorded fixture, one deterministic judge, two implementations:
 *
 *   retention  `admit.output`               vs `createPruneListener`
 *   skill      `select.skill`               vs `createSkillSuggestListener`
 *   completion `createGateTool`             vs `createJevGateTool`
 *
 * The judge is a pure function of the request: a segment containing `RELEVANT`
 * scores 0.9 and every other segment 0.06; a claim containing `supported` is
 * `verified`, one containing `contradicted` is `contradicted`, and anything else
 * is `not_addressed`. Because the oracle reads the *content* rather than a
 * position, it returns the same answer to both implementations even when their
 * chunk boundaries differ, which is the only way the comparison is fair.
 *
 * ## What this proves, and what it does not
 *
 * It proves the two implementations reach the same decision — the same retained
 * segments, the same skill, the same verdict per claim and the same overall
 * action — given identical judge answers. It does **not** prove their prompts
 * match, that they ask the same number of questions, or that live behaviour
 * matches: the baseline's compiled `lib/` is driven here through its exported
 * entry points with stub dependencies, never mounted, and the real judge is
 * never called. A divergence in prompt wording would be invisible to this gate.
 *
 * The baseline is read only. It stays installed and unmodified; nothing here
 * writes to `~/.dsh`.
 *
 * Usage:  node scripts/gate-t12-parity.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import admitOutput from '../packages/plugin/src/modules/admit-output.js';
import selectSkill from '../packages/plugin/src/modules/select-skill.js';
import { createGateTool } from '../packages/plugin/src/modules/gate-completion.js';

const BASELINE = process.env.JEV_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-jev-tools');
assert.ok(existsSync(BASELINE), `the installed baseline is required at ${BASELINE}`);
const baseline = (file) => import(pathToFileURL(join(BASELINE, 'lib', file)).href);
const { createPruneListener } = await baseline('features/prune.js');
const { createSkillSuggestListener } = await baseline('features/skill-suggest.js');
const { createJevGateTool } = await baseline('tools/jev-gate.js');

// ── the deterministic judge ──────────────────────────────────────────────

/** One answer per question, derived from the content the question is about. */
function oracle(request) {
  const state = request?.state ?? {};
  const questions = request?.questions ?? {};
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (id === 'pick') {
      const task = String(state.task ?? '');
      answers[id] = task.includes('meeting')
        ? { type: 'choice', choice: 'lark-minutes', confidence: 0.82 }
        : { type: 'choice', choice: 'none', confidence: 0.9 };
      continue;
    }
    if (question?.type === 'choice') {
      // The judge contract says "judge only from `evidence`", so with no evidence
      // the only honest answer is `not_addressed`. The oracle emulates that
      // documented contract rather than reading the claim text alone; otherwise
      // this stub would invent verdicts the real judge is told never to give.
      const evidence = String(state.evidence ?? '');
      const claim = String(state.claims?.[id] ?? '');
      const choice = evidence.trim() === ''
        ? 'not_addressed'
        : claim.includes('contradicted')
          ? 'contradicted'
          : claim.includes('supported')
            ? 'verified'
            : 'not_addressed';
      answers[id] = { type: 'choice', choice, confidence: choice === 'not_addressed' ? 0.4 : 0.9 };
      continue;
    }
    const segment = state.segments?.[id];
    const text = typeof segment === 'string' ? segment : '';
    answers[id] = { type: 'noul', noul: text.includes('RELEVANT') ? 0.9 : 0.06 };
  }
  return answers;
}

/** How many times each side asked the judge, so a short-circuit is visible. */
const calls = { ours: 0, theirs: 0 };

/** The judge as our modules see it: `api.judge.ask(state, questions, opts)`. */
const ask = async (state, questions) => {
  calls.ours += 1;
  return oracle({ state, questions });
};

/** The judge as the baseline sees it. */
const backendFor = () => ({
  judge: async (request) => {
    calls.theirs += 1;
    return {
      answers: oracle(request),
      model: 'stub',
      requestedModel: 'stub',
      usage: { inputTokens: 1 },
    };
  },
});

/** Settings, in the shape both sides read. Values are the shipped defaults. */
const settings = () => ({
  enabled: true,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  model: 'jev-latest',
  sessionCallLimit: 60,
  prune: {
    enabled: true,
    minTokens: 2000,
    minSaving: 0.15,
    toolAllowlist: ['read', 'grep', 'glob', 'web_fetch', 'web_search'],
    headLines: 40,
    tailLines: 40,
    keepHigh: 0.5,
    minKeepRatio: 0.2,
  },
  // Screening is compared by its own gate (T7); off here so the comparison is
  // about retention alone.
  screen: { enabled: false, minTokens: 300, threshold: 0.75, toolAllowlist: ['web_fetch', 'web_search'] },
  suggest: { enabled: true, minCatalogSize: 15, minConfidence: 0.5 },
});

const noop = () => {};
const baselineDeps = {
  settings,
  now: () => 0,
  ledger: { record: noop },
  notices: { note: noop },
  memo: { get: () => undefined, set: noop },
  cache: { task: () => currentTask, latest: () => currentTask, turn: () => 'turn-1' },
  pruner: () => undefined,
  credentials: () => ({ resolve: async () => ({ value: 'stub-key', source: 'stub' }) }),
  budget: { tryConsume: () => ({ ok: true }), tryConsumeSession: () => ({ ok: true }) },
  backendFor,
  skills: () => ({ list: async () => catalog }),
  log: noop,
  newMessageId: () => 'notice-1',
};

/** The module context our modules see. */
function moduleApi(overrides = {}) {
  const notices = [];
  const api = {
    id: 'parity',
    config: { get: (key) => ({ minTokens: 2000, minSaving: 0.15, minCatalogSize: 15, minConfidence: 0.5, minTaskChars: 12, autoAccept: 0.8, maxClaims: 16, autoCheck: false })[key] },
    judge: { configured: true, lastError: null, ask },
    budget: { tryAcquire: () => true, tryAcquireSession: () => true },
    ledger: { append: noop, record: noop },
    shadow: { isShadow: () => false },
    notice: { request: (request) => { notices.push(request); return 'accepted'; } },
    notifications: { send: async () => 'sent' },
    log: { warn: noop, info: noop },
    skills: () => ({ list: async () => catalog }),
    ...overrides,
  };
  return { api, notices };
}

let currentTask = '';

// ── fixtures ─────────────────────────────────────────────────────────────

/** A grep-like payload: 12 marked segments, half relevant, above the floor. */
function retentionFixture() {
  const parts = [];
  for (let index = 0; index < 12; index += 1) {
    const kind = index % 2 === 0 ? 'RELEVANT' : 'NOISE';
    const lines = [`SEG-${index} ${kind}`];
    for (let line = 0; line < 24; line += 1) {
      lines.push(`src/module-${index}.js:${line + 1}: const value_${index}_${line} = compute(${index}, ${line});`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/** Eighteen skills, so the catalog clears the size floor. */
const catalog = Array.from({ length: 18 }, (_, index) => ({
  name: index === 3 ? 'lark-minutes' : `skill-${index}`,
  description: index === 3
    ? 'Summarise a meeting recording into minutes with action items.'
    : `A routine helper for task number ${index}.`,
  userOnly: false,
}));

/** One user message carrying `text`. */
const messageOf = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const MEETING_TASK = 'Summarise the meeting recording into minutes.';

/** The markers a payload still carries, in order. */
const markersOf = (text) => (String(text).match(/^SEG-\d+ (?:RELEVANT|NOISE)$/gm) ?? []);

/** The skill named by an injection, or `null`. */
function skillOf(text) {
  const match = /([\w.-]+) \(raw probability/.exec(String(text));
  return match === null ? null : match[1];
}

const results = {};

// ── 1. retention ─────────────────────────────────────────────────────────

{
  const text = retentionFixture();
  currentTask = 'Find every call site of compute in the module tree.';
  const exec = {
    name: 'grep',
    arguments: { pattern: 'compute' },
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { id: 'agent-a' },
  };
  const result = { isError: false, content: [{ type: 'text', text }] };
  const next = async () => ({ kind: 'accept', content: [{ type: 'text', text }] });

  const { api } = moduleApi();
  const ours = await admitOutput.handle(exec, api, next);
  assert.equal(ours?.kind, 'accept', 'our module returns an accept decision');
  const oursKept = markersOf(ours.content?.[0]?.text);

  const theirs = await createPruneListener(baselineDeps)(exec, result, next);
  assert.equal(theirs?.kind, 'accept', 'the baseline returns an accept decision');
  const theirsKept = markersOf((theirs.content ?? []).map((block) => block.text ?? '').join('\n'));

  // Positive control: this fixture must actually prune, or the comparison below
  // would pass on two identical no-ops.
  assert.ok(theirsKept.length > 0, 'the baseline keeps some segments');
  assert.ok(theirsKept.length < 12, 'the baseline drops some segments');
  assert.ok(oursKept.length > 0 && oursKept.length < 12, 'our module prunes the same fixture');
  // Every relevant segment survives, and the only noise that survives is the
  // head/tail floor, which is kept unconditionally by both implementations.
  const FLOOR_NOISE = new Set(['SEG-1 NOISE', 'SEG-11 NOISE']);
  for (const kept of [oursKept, theirsKept]) {
    const set = new Set(kept);
    for (let index = 0; index < 12; index += 2) {
      assert.ok(set.has(`SEG-${index} RELEVANT`), `SEG-${index} is relevant and kept`);
    }
    assert.ok(
      kept.every((marker) => !marker.endsWith('NOISE') || FLOOR_NOISE.has(marker)),
      'noise is dropped except where the head/tail floor requires it',
    );
  }

  results.retention = { ours: oursKept, theirs: theirsKept };
  assert.deepEqual(oursKept, theirsKept, 'the same segments are retained');
}

// ── 2. skill selection ───────────────────────────────────────────────────

async function ourSkill(taskText) {
  const { api, notices } = moduleApi();
  await selectSkill.handle(
    { step: 1, turn: 'turn-1', agent: { id: 'agent-a' }, messages: [messageOf(taskText)] },
    api,
  );
  return skillOf(notices.map((notice) => notice.text).join('\n'));
}

async function baselineSkill(taskText) {
  currentTask = taskText;
  const listener = createSkillSuggestListener(baselineDeps);
  const out = await listener(
    { agent: { id: 'agent-a' }, turn: 'turn-1', signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );
  return skillOf((out?.messages ?? []).map((message) => (message.content ?? []).map((block) => block.text ?? '').join('')).join('\n'));
}

{
  const oursPick = await ourSkill(MEETING_TASK);
  const theirsPick = await baselineSkill(MEETING_TASK);
  assert.equal(oursPick, 'lark-minutes', 'our module picks the skill the judge chose');
  assert.equal(theirsPick, 'lark-minutes', 'the baseline picks the same skill');

  // Negative control: the same fixture with the abstention must pick nothing on
  // either side, so the comparison above is not just "both always find a name".
  const oursNone = await ourSkill('ok');
  const theirsNone = await baselineSkill('ok');
  assert.equal(oursNone, null, 'our module injects nothing when the judge abstains');
  assert.equal(theirsNone, null, 'the baseline injects nothing when the judge abstains');

  results.skill = { ours: oursPick, theirs: theirsPick };
}

// ── 3. completion verdict ────────────────────────────────────────────────

/** The action and the per-claim verdicts, from either tool definition. */
const verdictsOf = (out) => ({
  action: out.action,
  claims: (out.claims ?? []).map((reading) => reading.verdict),
});

{
  const exec = { callId: 'call-1', signal: new AbortController().signal, agent: { id: 'agent-a' } };
  currentTask = 'Verify the delivery.';
  const args = {
    request: 'Make the suite pass and handle empty input.',
    claims: [
      'the test suite passes, and it is supported by the output',
      'the output contradicted the second claim',
      'the third claim is not addressed by anything',
    ],
    evidence: 'run-1: 41 passed, 0 failed.',
  };

  const { api } = moduleApi();
  const ours = verdictsOf(await createGateTool(api).execute(args, exec));
  const theirs = verdictsOf(await createJevGateTool(baselineDeps).execute(args, exec));

  assert.deepEqual(ours.claims, ['verified', 'contradicted', 'not_addressed'], 'our gate reads every claim');
  assert.deepEqual(theirs.claims, ['verified', 'contradicted', 'not_addressed'], 'the baseline reads every claim');
  assert.equal(ours.action, 'escalate', 'a contradicted claim escalates both ways');
  assert.equal(theirs.action, ours.action, 'the same overall action');

  // Negative control: no evidence means nothing can be verified, on either side.
  const emptyArgs = { ...args, evidence: '' };
  const ourCallsBefore = calls.ours;
  const baselineCallsBefore = calls.theirs;
  const oursEmpty = verdictsOf(await createGateTool(api).execute(emptyArgs, exec));
  const theirsEmpty = verdictsOf(await createJevGateTool(baselineDeps).execute(emptyArgs, exec));
  assert.deepEqual(oursEmpty.claims, ['not_addressed', 'not_addressed', 'not_addressed']);
  assert.deepEqual(theirsEmpty.claims, oursEmpty.claims, 'empty evidence is read the same way');
  assert.equal(theirsEmpty.action, oursEmpty.action, 'and produces the same action');
  assert.notEqual(oursEmpty.action, 'auto', 'no claim is accepted without evidence');
  // One deliberate difference, recorded rather than hidden: with no evidence at
  // all, our gate returns `not_addressed` without asking the judge, while the
  // baseline still sends the request. The verdicts agree; the cost does not.
  assert.equal(calls.ours - ourCallsBefore, 0, 'our gate short-circuits when there is no evidence');
  assert.ok(calls.theirs - baselineCallsBefore >= 1, 'the baseline still asks the judge');

  results.completion = { ours: ours.action, theirs: theirs.action, claims: ours.claims };
}

assert.deepEqual(results.retention.ours, results.retention.theirs);
assert.equal(results.skill.ours, results.skill.theirs);
assert.equal(results.completion.ours, results.completion.theirs);
console.log('GATE-T12-PARITY-OK');
