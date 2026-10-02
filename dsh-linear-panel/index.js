/**
 * Host half of @local/dsh-linear.
 *
 * Registers one same-origin POST route (/dsh-linear) that forwards the request
 * body to Linear's GraphQL API with the personal API key read from the linear
 * CLI's credentials file. The Client half owns all queries and rendering.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const ROUTE = '/dsh-linear';
const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const MAX_BODY_BYTES = 512 * 1024;

export const inject = ['webServer'];

/** Read the active Linear personal API key from the linear CLI credentials file. */
async function linearApiKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const file = process.env.LINEAR_CREDENTIALS_FILE ?? path.join(homedir(), '.config', 'linear', 'credentials.toml');
  const text = await readFile(file, 'utf8');
  const def = text.match(/^\s*default\s*=\s*"([^"]+)"/m);
  if (def) {
    const named = text.match(new RegExp(`^\\s*${def[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]+)"`, 'm'));
    if (named) return named[1];
  }
  const any = text.match(/"(lin_api_[^"]+)"/);
  if (any) return any[1];
  throw new Error(`no Linear API key found in ${file}`);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const route = {
  kind: 'exact',
  path: ROUTE,
  handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        // Same-origin only: this route proxies an authenticated API.
        const origin = req.headers.origin;
        if (origin) {
          const originHost = new URL(origin).host;
          if (originHost !== req.headers.host) return json(res, 403, { error: 'cross-origin request rejected' });
        }
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'invalid JSON body' });
        }
        if (typeof payload?.query !== 'string' || payload.query.length > 100_000) {
          return json(res, 400, { error: 'missing GraphQL query' });
        }
        const apiKey = await linearApiKey();
        const upstream = await fetch(LINEAR_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: apiKey },
          body: JSON.stringify({ query: payload.query, variables: payload.variables ?? undefined }),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(text);
      } catch (error) {
        json(res, 502, { errors: [{ message: `dsh-linear: ${error?.message ?? error}` }] });
      }
    },
  };

export function apply(ctx) {
  // Ceiling: a prior generation of this same file (bundle reinstalled without
  // a restart) may still own the route — we then silently retry every 5s until
  // it disposes, while the identical handler keeps serving. Upgrade path:
  // have the loader dispose a removed entry's fiber before reactivation.
  let owned = null;
  let pending = true;
  const tryRegister = () => {
    if (!pending) return;
    try {
      owned = ctx.webServer.register(route);
      pending = false;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes('duplicate exact route')) {
        pending = false;
        throw error;
      }
    }
  };
  tryRegister();
  const retry = pending ? setInterval(tryRegister, 5000) : null;
  return () => {
    pending = false;
    if (retry) clearInterval(retry);
    if (owned) owned();
  };
}
