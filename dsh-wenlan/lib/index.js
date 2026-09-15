import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const name = 'dsh-wenlan';
const inject = ['commands', 'systemPrompt', 'tools'];
const home = process.env.HOME || '/home/sil';
const spacesFile = process.env.SPACES_FILE || join(home, '.wenlan', 'spaces.toml');

const COMMANDS = [
  {
    name: 'capture',
    description: 'Capture durable project knowledge in Wenlan.',
    instruction: 'Use the Wenlan capture workflow. Capture durable project facts, decisions, lessons, or gotchas from the user input below. Check mcp__wenlan__recall first for a likely duplicate. Use explicit session Space routing on every applicable tool call. Do not capture transient details or user preferences handled by dsh-mneme.',
  },
  {
    name: 'recall',
    description: 'Recall project knowledge from Wenlan.',
    instruction: 'Use the Wenlan recall workflow. Search the user query below with mcp__wenlan__recall, using the explicit session Space. Present the most relevant results concisely and inspect revisions only when useful.',
  },
  {
    name: 'brief',
    description: 'Resume project context from the Wenlan Space Brief.',
    instruction: 'Use the Wenlan brief workflow. Read the current Space Brief for the session, then summarize the last-session context, active work, backlog, and related context. Show pending revisions but never accept or dismiss them unless the user explicitly asks.',
  },
  {
    name: 'distill',
    description: 'Distill Wenlan memories into a maintained page.',
    instruction: 'Use the Wenlan distill workflow. Inspect the relevant memories and page state, then run the appropriate distillation for the requested target and Space. Preserve user-edited page content and do not overwrite it without explicit confirmation.',
  },
  {
    name: 'pages',
    description: 'List, inspect, author, or remove Wenlan pages.',
    instruction: 'Use the Wenlan pages workflow. For listing or opening pages, use the Wenlan CLI through Bash as needed. For page history use mcp__wenlan__get_page_revisions. For authoring use mcp__wenlan__write_page. For deletion, identify the exact page and ask for explicit confirmation immediately before mcp__wenlan__delete_page.',
  },
  {
    name: 'lint',
    description: 'Check and optionally repair Wenlan data integrity.',
    instruction: 'Use the Wenlan lint workflow. Run the requested general or deep lint check with the session Space. For repair, prepare the repair plan, present the proposed changes, obtain explicit confirmation, then apply and verify the exact plan. Never apply a repair merely because lint found it.',
  },
  {
    name: 'curate',
    description: 'Review pending Wenlan captures, revisions, or refinements.',
    instruction: 'Use the Wenlan curation workflow. Review the requested pending captures, revisions, or refinements and explain the choices. Never confirm, forget, accept, or reject an item unless the user explicitly selects that item and action.',
  },
];

function nonempty(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function mappings() {
  try {
    const text = readFileSync(spacesFile, 'utf8');
    return text.split(/\[\[mapping\]\]/).slice(1).flatMap((block) => {
      const prefix = block.match(/^\s*prefix\s*=\s*"([^"]+)"/m)?.[1];
      const space = block.match(/^\s*space\s*=\s*"([^"]+)"/m)?.[1];
      return prefix && space ? [{ prefix, space }] : [];
    });
  } catch {
    return [];
  }
}

function resolveSpace(context) {
  const strict = nonempty(process.env.WENLAN_SPACE);
  if (strict) return strict;

  const cwd = nonempty(context?.agent?.session?.header?.cwd);
  if (cwd) {
    let best;
    for (const mapping of mappings()) {
      if ((cwd === mapping.prefix || cwd.startsWith(`${mapping.prefix}/`))
        && (!best || mapping.prefix.length > best.prefix.length)) {
        best = mapping;
      }
    }
    if (best) return best.space;
  }

  return nonempty(process.env.WENLAN_DEFAULT_SPACE) || 'work';
}

const SPACE_SCOPED_TOOLS = new Set([
  'brief',
  'capture',
  'create_entity',
  'list_entities',
  'list_pending',
  'lint',
  'recall',
  'write_page',
]);

function wenlanSpaceGuard(execution) {
  const prefix = 'mcp__wenlan__';
  if (!execution?.name?.startsWith(prefix)) return;

  const toolName = execution.name.slice(prefix.length);
  const args = execution.arguments;
  const directSpace = SPACE_SCOPED_TOOLS.has(toolName);
  const registeredLint = (toolName === 'prepare_lint_repair' || toolName === 'prepare_lint_repair_plan')
    && args?.lint_scope?.kind === 'registered';
  if (!directSpace && !registeredLint) return;

  const agent = execution.agent;
  const cwd = nonempty(agent?.session?.header?.cwd);
  if (!cwd && !nonempty(process.env.WENLAN_SPACE)) {
    return 'Wenlan Space guard: the session workspace is unavailable; refusing an unscoped call.';
  }

  const expected = resolveSpace({ agent });
  const received = directSpace ? nonempty(args?.space) : nonempty(args?.lint_scope?.space);
  if (!received) {
    return `Wenlan Space guard: ${execution.name} must include space="${expected}".`;
  }
  if (received !== expected) {
    return `Wenlan Space guard: ${execution.name} requested Space "${received}", but this session maps to "${expected}".`;
  }
}

function submit(command, invocation) {
  const suffix = nonempty(invocation?.rawInput);
  const text = suffix ? `${command.instruction}\n\nUser command input:\n${suffix}` : command.instruction;
  const agent = invocation?.agent;
  if (typeof agent?.followup !== 'function') {
    return { kind: 'success', text };
  }
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }));
    return { kind: 'success', text: `Submitted /${command.name} to the agent.` };
  } catch (error) {
    return { kind: 'error', text: `Could not submit /${command.name}: ${String(error)}` };
  }
}

function apply(ctx) {
  const spaceGuard = ctx.tools.guard(wenlanSpaceGuard);
  const commandDisposers = COMMANDS.map((command) => ctx.commands.register({
    name: command.name,
    description: command.description,
    input: { hint: 'Optional arguments' },
    handler: (invocation) => submit(command, invocation),
  }));

  const routing = ctx.systemPrompt.context({
    name: 'dsh-wenlan-space-routing',
    order: 75,
    text: (context) => {
      const space = resolveSpace(context);
      return `Wenlan routing: this DSH session uses Space "${space}". For every mcp__wenlan tool that accepts a space parameter, pass space="${space}" explicitly.`;
    },
  });

  const captureGuidance = ctx.systemPrompt.context({
    name: 'dsh-wenlan-capture-guidance',
    order: 76,
    text: 'Wenlan capture policy: proactively capture durable project facts, decisions, lessons, and gotchas when the user shares them. Do not capture transient details or user preferences; dsh-mneme owns those separately. Never silently apply destructive Wenlan operations.',
  });

  ctx.effect(() => {
    spaceGuard();
    for (const dispose of commandDisposers) dispose();
    routing();
    captureGuidance();
  });
}

export { apply, inject, name };
