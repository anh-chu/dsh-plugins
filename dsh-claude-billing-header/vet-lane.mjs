// vet-lane.mjs: find the minimal tool subset that flips an Anthropic OAuth
// request into the extra-usage lane. Usage:
//   node vet-lane.mjs [path-to-captured-body.json]
// Defaults to ~/.dsh/claude-last-body.json (written by the plugin's
// captureFile option). Implements ddmin: needs a reproducer first (the full
// captured tool set must flip with the billing header applied).
//
// Only the HTTP status + error lane are inspected. 200s burn subscription
// quota at the captured body size; 400 extra-usage rejections are unbilled.
// Token is read from disk and never printed.
import { readFileSync } from "node:fs";
import { buildBillingHeader } from "./lib/index.js";

const HOME = process.env.HOME;
const capturePath = process.argv[2] ?? `${HOME}/.dsh/claude-last-body.json`;
const auth = JSON.parse(readFileSync(`${HOME}/.dsh/plugins/subscriptions/auth.json`, "utf8"));
const TOKEN = auth.claude.accounts[auth.claude.default].accessToken;
const captured = JSON.parse(readFileSync(capturePath, "utf8"));

const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "compact-2026-01-12",
    "files-api-2025-04-14",
  ].join(","),
  "user-agent": "claude-cli/2.1.236 (external, cli)",
  "x-app": "cli",
  "anthropic-dangerous-direct-browser-access": "true",
  "content-type": "application/json",
};

const headerText = buildBillingHeader(captured.messages, "2.1.236", "cli");
let requests = 0;

// Returns true when the subset flips to the extra-usage lane.
async function flips(tools) {
  requests += 1;
  const body = {
    ...captured,
    system: [{ type: "text", text: headerText }, ...captured.system],
    tools,
  };
  const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  try {
    await res.body?.cancel();
  } catch {}
  if (res.status === 400 && text.includes("extra usage")) return true;
  if (res.status === 200) return false;
  throw new Error(`unexpected status ${res.status}: ${text.slice(0, 120)}`);
}

function names(tools) {
  return tools.map((t) => t.name);
}

console.log(`tools in capture: ${captured.tools.length}, model: ${captured.model}`);
if (!(await flips(captured.tools))) {
  console.log("No repro: full captured tool set does NOT flip. Nothing to minimize.");
  process.exit(0);
}
console.log("Repro confirmed: full set flips.");

// Textbook ddmin over the tool list (finds pairs, not just singles).
let current = [...captured.tools];
let n = 2;
while (current.length >= 2) {
  const size = Math.ceil(current.length / n);
  let reduced = false;
  for (let i = 0; i < n; i++) {
    const subset = current.slice(i * size, (i + 1) * size);
    if (subset.length === 0) continue;
    if (await flips(subset)) {
      console.log(`  [${requests}] subset of ${subset.length} flips: ${names(subset).join(",")}`);
      current = subset;
      n = 2;
      reduced = true;
      break;
    }
  }
  if (reduced) continue;
  for (let i = 0; i < n; i++) {
    const subset = current.slice(i * size, (i + 1) * size);
    const complement = current.filter((t) => !subset.includes(t));
    if (complement.length === 0 || complement.length === current.length) continue;
    if (await flips(complement)) {
      console.log(`  [${requests}] complement of ${subset.length} flips (${complement.length} tools left)`);
      current = complement;
      n = Math.max(2, n - 1);
      reduced = true;
      break;
    }
  }
  if (reduced) continue;
  if (n >= current.length) break;
  n = Math.min(current.length, n * 2);
}

console.log(`\nMinimal flipping set (${current.length} tools, ${requests} requests):`);
for (const t of current) console.log(`  - ${t.name}`);
