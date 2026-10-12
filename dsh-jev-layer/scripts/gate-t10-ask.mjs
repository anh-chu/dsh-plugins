/**
 * G-T10-1 — the `jev_ask` tool.
 *
 * Runs the real module against a synthetic `api` (the shape docs/CONTRACT.md
 * fixes) with a stub judge. No network, no host, no core import: the module must
 * be decidable from the frozen interface alone.
 *
 * What the gate proves:
 *
 *   (a) a batch of one noul, one choice and one score question returns exactly
 *       one finite probability per question id;
 *   (b) an unconfigured judge reports `unconfigured` and never reaches the
 *       transport;
 *   (c) a `null` judge result reports instead of throwing;
 *   (d) shadow mode still answers and records the call as shadow traffic;
 *   (e) `start` registers `jev_ask` through the tools service and `stop` releases
 *       it; with no tools service `start` warns instead of throwing.
 *
 * (a) is the positive control for the absence asserted in (b): the same call
 * counter shows the judge was reached in (a) and never reached in (b).
 *
 * Run from the repository root: `node scripts/gate-t10-ask.mjs`
 */

import assert from 'node:assert/strict';
import toolsAsk, { createJevAskTool } from '../packages/plugin/src/modules/tools-ask.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

/** Marker printed last, after every assertion passed. */
const MARKER = 'GATE-T10-ASK-OK';

/** One typed question of each accepted shape. */
const QUESTIONS = {
  n1: {
    type: 'noul',
    instructions: 'Is the claim supported by the cited evidence?',
    criteria: { true: 'the evidence states it', false: 'the evidence does not state it' },
  },
  c1: {
    type: 'choice',
    instructions: 'Which category does the item belong to?',
    criteria: { yes: 'it is a request', no: 'it is a report' },
  },
  s1: {
    type: 'score',
    instructions: 'How complete is the change?',
    criteria: ['nothing done', 'partial', 'complete'],
  },
};

const IDS = Object.keys(QUESTIONS);

/** The stub answers, shaped as the vendor returns them. */
const ANSWERS = {
  n1: { type: 'noul', noul: 0.82 },
  c1: { type: 'choice', choice: 'yes', confidence: 0.7, probabilities: { yes: 0.7, no: 0.3 } },
  s1: { type: 'score', score: 0.4, confidence: 0.9, legend: { 0: 'nothing done' } },
};

/**
 * A synthetic module api with a stub judge.
 *
 * @param {object} [options] the overrides one case needs.
 * @returns {object} the api, plus `_calls` and `_records` for the assertions.
 */
function makeApi(options = {}) {
  const calls = [];
  const records = [];
  const warnings = [];
  const configured = options.configured ?? true;
  const judge = {
    configured,
    lastError: null,
    async ask(state, questions, opts) {
      calls.push({ state, questions, opts });
      if (options.throwOnAsk === true) throw new Error('transport exploded');
      if (options.answers === null) {
        judge.lastError = options.lastError ?? { kind: 'unconfigured' };
        return null;
      }
      return options.answers ?? ANSWERS;
    },
  };
  return {
    id: 'tools.ask',
    config: { get: () => undefined },
    judge,
    budget: {
      beginTurn() {},
      tryAcquire: () => options.budget !== false,
      remaining: () => 1,
    },
    ledger: {
      append(record) {
        records.push(record);
        return record;
      },
      read: () => records,
      rebuild: (events) => events,
    },
    shadow: { isShadow: () => options.shadow === true },
    notice: { request: () => 'accepted', drain: () => [] },
    notifications: { send: async () => 'sent' },
    log: { warn: (message) => warnings.push(String(message)), info() {} },
    seams: SEAMS,
    registerAgent: () => () => {},
    _calls: calls,
    _records: records,
    _warnings: warnings,
  };
}

/** Build one tool against its own api, so state cannot leak between cases. */
const toolFor = (options) => {
  const api = makeApi(options);
  return { api, tool: createJevAskTool(api) };
};

const exec = { callId: 'call-1', agent: { id: 'agent-1' } };

// ── (a) typed questions in, one probability per id out ─────────────────────
{
  const { api, tool } = toolFor({});
  const result = await tool.execute({ state: 'the material', questions: QUESTIONS }, exec);

  assert.equal(tool.name, 'jev_ask');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 0, 'the description is model-visible and must not be empty');
  assert.ok(tool.parameters && typeof tool.parameters === 'object', 'parameters are required');
  assert.ok(tool.output && typeof tool.output.render === 'function', 'a ToolDefinition needs output.render');
  assert.equal(tool.isConcurrencySafe({}), true);
  assert.equal(typeof tool.timeoutMs, 'number');

  assert.equal(result.ok, true, 'a configured judge produces a judgment');
  assert.equal(result.problem, undefined);
  assert.deepEqual(
    Object.keys(result.probabilities).sort(),
    [...IDS].sort(),
    'exactly one probability per question id',
  );
  for (const id of IDS) {
    const value = result.probabilities[id];
    assert.equal(typeof value, 'number', `${id} must be a number`);
    assert.ok(Number.isFinite(value), `${id} must be finite`);
    assert.ok(value >= 0 && value <= 1, `${id} must be a probability, got ${value}`);
  }
  assert.equal(result.probabilities.n1, 0.82, 'a noul answer reads as its own probability');
  assert.equal(result.probabilities.c1, 0.7, 'a choice answer reads as the chosen option probability');
  assert.equal(result.probabilities.s1, 0.4, 'a score answer reads as its own score');

  // Positive control for (b): the judge really is reached on the answering path.
  assert.equal(api._calls.length, 1, 'the judge was asked exactly once');
  assert.equal(api._calls[0].opts.featureId, 'tools.ask');
  assert.equal(api._records.length, 1, 'the call is recorded once');
  assert.equal(api._records[0].mode, 'enforce');
  assert.equal(api._records[0].featureId, 'tools.ask');

  // The renderer is total.
  const blocks = tool.output.render({}, result);
  assert.ok(Array.isArray(blocks) && blocks[0].type === 'text' && typeof blocks[0].text === 'string');
}

// ── (b) unconfigured: reports, never throws, never calls the transport ─────
{
  const { api, tool } = toolFor({ configured: false });
  let result;
  await assert.doesNotReject(async () => {
    result = await tool.execute({ state: 'x', questions: QUESTIONS }, exec);
  }, 'an unconfigured judge must not throw');
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'unconfigured');
  assert.equal(typeof result.message, 'string');
  assert.equal(api._calls.length, 0, 'no request leaves the machine without a credential');
  assert.equal(api._records.length, 1, 'the refusal is recorded');
}

// ── (c) the judge answers `null` (unconfigured that the getter missed) ─────
{
  const { tool } = toolFor({ configured: true, answers: null, lastError: { kind: 'unconfigured' } });
  let result;
  await assert.doesNotReject(async () => {
    result = await tool.execute({ state: 'x', questions: QUESTIONS }, exec);
  });
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'unconfigured', 'lastError.kind names why the answer is missing');

  const thrown = toolFor({ configured: true, throwOnAsk: true });
  const afterThrow = await thrown.tool.execute({ state: 'x', questions: QUESTIONS }, exec);
  assert.equal(afterThrow.ok, false, 'a throwing judge is reported, not propagated');
}

// ── (c2) malformed input is reported, not thrown ───────────────────────────
{
  const { tool } = toolFor({});
  const bad = await tool.execute({ state: 'x', questions: { q: { type: 'sort', instructions: 'x' } } }, exec);
  assert.equal(bad.ok, false);
  assert.equal(bad.problem, 'invalid-request');
  const empty = await tool.execute({ state: 'x', questions: {} }, exec);
  assert.equal(empty.problem, 'invalid-request');
}

// ── (c2b) a JSON string that encodes the questions object is accepted ──────
// On a real turn the model sent `questions` as a string four times running and each
// call was refused as "must be an object", because the schema gave no type to follow.
{
  const { tool } = toolFor({ configured: true });
  const viaString = await tool.execute({ state: 'x', questions: JSON.stringify({ n1: QUESTIONS.n1 }) }, exec);
  assert.equal(viaString.ok, true, 'a string that parses to an object is the object it encodes');

  // Controls: strings that do not encode a plain object are still refused.
  for (const bad of ['not json', '[1,2]', '"text"', '{broken']) {
    const refused = await tool.execute({ state: 'x', questions: bad }, exec);
    assert.equal(refused.problem, 'invalid-request', `a string that is not an object is refused: ${bad}`);
  }

  const { tool: declared } = toolFor({});
  assert.equal(declared.parameters.properties.questions.type, 'object', 'the schema types `questions` as an object');
}

// ── (c3) the shared budget is spent before the request goes out ────────────
{
  const { api, tool } = toolFor({ budget: false });
  const result = await tool.execute({ state: 'x', questions: QUESTIONS }, exec);
  assert.equal(result.ok, false);
  assert.equal(result.problem, 'budget-exhausted');
  assert.equal(api._calls.length, 0, 'a refused budget must not spend a request');
}

// ── (d) shadow mode still answers, and records the call ────────────────────
{
  const { api, tool } = toolFor({ shadow: true });
  const result = await tool.execute({ state: 'x', questions: QUESTIONS }, exec);
  assert.equal(result.ok, true, 'a read-only judgment is still delivered in shadow mode');
  assert.deepEqual(Object.keys(result.probabilities).sort(), [...IDS].sort());
  assert.equal(api._records.length, 1);
  assert.equal(api._records[0].mode, 'shadow', 'the shadow call is recorded as shadow traffic');
  assert.deepEqual(api._records[0].probabilities, result.probabilities);
}

// ── (e) registration through the tools service, and disposal ───────────────
{
  const registered = [];
  const disposed = [];
  const api = makeApi({});
  api.tools = {
    register(definition) {
      registered.push(definition);
      return () => disposed.push(definition.name);
    },
  };

  toolsAsk.start(api);
  assert.equal(registered.length, 1, 'start registers exactly one tool');
  assert.equal(registered[0].name, 'jev_ask');
  assert.equal(typeof registered[0].execute, 'function');
  assert.equal(registered[0].parameters.required.includes('questions'), true);

  // The registered definition is the same working tool.
  const called = await registered[0].execute({ state: 'x', questions: { n1: QUESTIONS.n1 } }, exec);
  assert.equal(called.ok, true);

  toolsAsk.stop();
  assert.deepEqual(disposed, ['jev_ask'], 'stop releases what start registered');

  // The alternative bridge: the plugin context.
  const viaCtx = [];
  const ctxApi = makeApi({});
  ctxApi.ctx = { get: (name) => (name === 'tools' ? { register: (def) => { viaCtx.push(def.name); return () => {}; } } : undefined) };
  toolsAsk.start(ctxApi);
  assert.deepEqual(viaCtx, ['jev_ask'], 'a tools service on the host context is used too');
  toolsAsk.stop();

  // No tools service at all: one warning, no throw, nothing registered.
  const bare = makeApi({});
  await assert.doesNotReject(async () => {
    toolsAsk.start(bare);
  }, 'a missing tools service must not fail the module');
  assert.equal(bare._warnings.length, 1, 'the gap is reported once');
  assert.ok(bare._warnings[0].includes('jev_ask'), 'the warning names the tool');
  assert.doesNotThrow(() => toolsAsk.stop());
}

console.log(MARKER);
