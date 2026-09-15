import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const WENLAN = '/home/sil/.wenlan/bin/wenlan-mcp';
const ORIGIN = 'http://127.0.0.1:7878';
const AGENT = 'dsh';
// Keep the MCP surface limited to the Wenlan workflows registered by the DSH bundle.
const ALLOWED_TOOLS = new Set([
  'accept_refinement',
  'accept_revision',
  'apply_lint_repair',
  'brief',
  'capture',
  'confirm_memory',
  'create_entity',
  'create_relation',
  'delete_page',
  'dismiss_revision',
  'distill',
  'forget',
  'get_lint_agent_work_page',
  'get_lint_repair_plan_entries',
  'get_memory_revisions',
  'get_page_revisions',
  'get_page_sources',
  'lint',
  'list_entities',
  'list_pending',
  'list_pending_imports',
  'list_pending_revisions',
  'list_refinements',
  'list_rejections',
  'prepare_lint_repair',
  'prepare_lint_repair_plan',
  'recall',
  'reject_refinement',
  'verify_lint_repair',
  'write_page',
]);

const child = spawn(WENLAN, ['--origin-url', ORIGIN, '--agent-name', AGENT], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();

function idKey(id) {
  return JSON.stringify(id);
}

function send(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function isAllowed(name) {
  return typeof name === 'string' && ALLOWED_TOOLS.has(name);
}

const clientInput = createInterface({ input: process.stdin });
clientInput.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message?.method === 'tools/call') {
    const name = message.params?.name;
    if (!isAllowed(name)) {
      if (message.id !== undefined) {
        send(process.stdout, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Wenlan tool is not enabled in DSH: ${String(name)}`,
          },
        });
      }
      return;
    }
  }

  if (message?.id !== undefined && message?.method) {
    pending.set(idKey(message.id), message.method);
  }
  send(child.stdin, message);
});

const serverOutput = createInterface({ input: child.stdout });
serverOutput.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const method = message?.id !== undefined ? pending.get(idKey(message.id)) : undefined;
  if (method === 'tools/list' && Array.isArray(message.result?.tools)) {
    message.result.tools = message.result.tools.filter((tool) => isAllowed(tool?.name));
    // Some providers (e.g. Copilot's Gemini shim) reject function tools whose
    // object schema has no `properties` key with HTTP 400. Normalise it here.
    for (const tool of message.result.tools) {
      const schema = tool?.inputSchema;
      if (schema && typeof schema === 'object' && schema.type === 'object' && schema.properties === undefined) {
        schema.properties = {};
      }
    }
  }
  if (message?.id !== undefined) pending.delete(idKey(message.id));
  send(process.stdout, message);
});

function shutdown() {
  if (!child.killed) child.kill();
}

clientInput.on('close', shutdown);
child.on('error', (error) => {
  process.stderr.write(`dsh-wenlan proxy: ${error.message}\n`);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
