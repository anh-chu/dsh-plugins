/**
 * G-T30-1: a module's api carries the host's `sandboxPolicy` service.
 *
 * `approve.workspace` handles an escalation only when the session runs in
 * `workspace-write`, and it reads that mode from `api.sandboxPolicy.resolve({ session })`.
 * Nothing in the registry handed the service over, so on a real turn the mode was always
 * unknown, every escalation was "not eligible", and the module neither acted nor recorded
 * why: a write that needed approval failed with "no approval channel" and the ledger stayed
 * empty. `gate-t23-approve` could not see it because it builds the module's api by hand and
 * includes `sandboxPolicy` itself.
 *
 * This gate goes through the REAL registry: a host context that serves a `sandboxPolicy`
 * service, a real `tools/pre-execute` dispatch, and a real module, and it reads the ledger.
 *
 * Run: node scripts/gate-t30-sandboxpolicy.mjs
 */
import assert from 'node:assert/strict';

import { createCore } from '../packages/core/src/index.js';
import approveWorkspace from '../packages/plugin/src/modules/approve-workspace.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

function hostCtx({ withPolicy = true, late = false } = {}) {
  const listeners = new Map();
  let mounted = !late;
  const policy = { resolve: ({ session } = {}) => ({ mode: 'workspace-write', sessionId: session?.id }) };
  return {
    listeners,
    mount: () => { mounted = true; },
    on(seam, fn) {
      listeners.set(seam, fn);
      return () => listeners.delete(seam);
    },
    get: (name) => (name === 'sandboxPolicy' && withPolicy && mounted ? policy : undefined),
    inject: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    logger: { warn() {}, info() {} },
  };
}

/** The shape the module reads: one answer per question id, `{ choice, probabilities }`. */
const APPROVE = { authorization: { choice: 'approve', probabilities: { approve: 0.95, unauthorized: 0.03, unknown: 0.02 } } };
const escalation = {
  name: 'write',
  callId: 'w1',
  agent: { id: 'agent-a', session: { id: 'session-a' } },
  arguments: {
    file_path: '/etc/probe.txt',
    content: 'hello',
    sandbox_permissions: 'danger-full-access',
    justification: 'Writing a probe file the operator asked for',
  },
};

async function run(ctx) {
  const ledger = [];
  const core = createCore({
    settings: { get: (key) => ({ mode: 'enforce', 'approve.workspace.mode': 'enforce' })[key] },
    now: () => 1,
  });
  core.ledger.append = (row) => ledger.push(row);
  core.judge.ask = async () => APPROVE;
  Object.defineProperty(core.judge, 'configured', { value: true, configurable: true });
  const config = { 'approve.workspace': { enabled: { get: () => true } } };
  const registry = createRegistry({ modules: [approveWorkspace], ctx, config, core });
  await registry.start();
  const listener = ctx.listeners.get(SEAMS.TOOLS_PRE_EXECUTE);
  assert.equal(typeof listener, 'function', 'the pre-execute listener is registered');
  const decision = await listener(escalation, () => ({ kind: 'allow' }));
  await registry.stop();
  return { decision, ledger };
}

// ── the module reaches the service through the registry ─────────────────────
{
  const { decision, ledger } = await run(hostCtx());
  assert.equal(decision?.kind, 'ask', 'an eligible escalation is put in front of the human');
  assert.ok(ledger.some((row) => row.featureId === 'approve.workspace'), 'and the call is recorded');
}

// ── a service that mounts after the module starts is still seen ─────────────
{
  const ctx = hostCtx({ late: true });
  const ledger = [];
  const core = createCore({ settings: { get: (key) => ({ mode: 'enforce', 'approve.workspace.mode': 'enforce' })[key] }, now: () => 1 });
  core.ledger.append = (row) => ledger.push(row);
  core.judge.ask = async () => APPROVE;
  Object.defineProperty(core.judge, 'configured', { value: true, configurable: true });
  const registry = createRegistry({ modules: [approveWorkspace], ctx, config: { 'approve.workspace': { enabled: { get: () => true } } }, core });
  await registry.start();
  ctx.mount();
  const decision = await ctx.listeners.get(SEAMS.TOOLS_PRE_EXECUTE)(escalation, () => ({ kind: 'allow' }));
  assert.equal(decision?.kind, 'ask', 'a policy service that mounts later is read on each call');
  await registry.stop();
}

// ── control: with no sandboxPolicy service the harness's own decision stands ─
{
  const { decision, ledger } = await run(hostCtx({ withPolicy: false }));
  assert.deepEqual(decision, { kind: 'allow' }, 'control: an unknown mode is not eligible and the decision is untouched');
  assert.equal(ledger.filter((row) => row.featureId === 'approve.workspace').length, 0, 'control: nothing is judged');
}

console.log('GATE-T30-SANDBOXPOLICY-OK');
