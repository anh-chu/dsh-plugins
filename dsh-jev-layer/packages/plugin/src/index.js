/**
 * dsh-jev-layer — host half entry.
 *
 * One loader row, every feature inside it. `apply()` registers nothing itself:
 * it defers, because a throw during `apply()` fails the whole loader entry and
 * takes every feature offline. The deferred boot builds the core, then the
 * registry, then starts the enabled modules one at a time.
 *
 * `Config` may be `undefined`: `@deepseek-ai/schemastery` is imported by
 * config.js in a try/catch, and it does not resolve when the plugin is installed
 * by a `file:` link. Cordis skips config validation in that case and still
 * passes the configured object to `apply()`.
 *
 * The core is imported by relative path, not by the `dsh-jev-layer-core`
 * package name: this repository has no `node_modules`, and a relative path also
 * resolves through the symlink a `file:` install creates.
 */

import MODULES from './modules/index.js';
import { GLOBAL_DEFAULTS, buildConfig, createSettings, readConfig, resolveLedgerPath, schemastery } from './config.js';
import { createRegistry } from './registry.js';

export const name = 'dsh-jev-layer';
export const inject = [];
export const Config = buildConfig(MODULES, schemastery);

/**
 * The settings service emits this after a write. Its name is not in seams.js,
 * and seams.js is frozen, so it is a literal here and only here.
 */
const SETTINGS_UPDATED = 'settings/document-updated';

/** The live registry, for a status surface. Null until the deferred boot runs. */
let current = null;

/** The state of every module: `{ id, seam, enabled, started, error }[]`. */
export function registryState() {
  return current ? current.state() : [];
}

export function apply(ctx, config) {
  const live = config ?? {};
  // Return first. Everything below happens in a later microtask.
  queueMicrotask(() => {
    void boot(ctx, live);
  });
}

async function boot(ctx, live) {
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(`[dsh-jev-layer] ${message}`);
    } catch {
      /* logging must never be the failure */
    }
  };

  let createCore;
  try {
    ({ createCore } = await import('../../core/src/index.js'));
  } catch {
    try {
      // Installed through a `file:` link, the plugin directory is *copied* into
      // the profile's `node_modules`, so a relative `../../core` points outside
      // the package. The package name is the portable form; the relative path
      // above is the form that works straight out of the repository, where no
      // `node_modules` exists.
      ({ createCore } = await import('dsh-jev-layer-core'));
    } catch (error) {
      warn(`the core could not be loaded, every module stays off: ${messageOf(error)}`);
      return;
    }
  }
  if (typeof createCore !== 'function') {
    warn('the core does not export createCore, every module stays off');
    return;
  }

  // Resolve the credential before the core is built, so `judge.configured` is
  // honest from the first module start. This is still inside the deferred boot:
  // `apply()` returned a microtask ago.
  const credential = createCredential(ctx, live, warn);
  await credential.refresh();

  let core;
  try {
    const settings = createSettings(live, () => credential.read());
    // A ledger that only lives in memory cannot keep shadow mode's promise: the
    // records are gone the moment the host exits, so there is nothing to compare
    // your own answers against later. So an empty `ledgerPath` means the built-in
    // file in the DSH home, and only `off` keeps the ledger in memory.
    core = createCore({
      settings,
      log: ctx?.logger,
      statePath: resolveLedgerPath(settings.get('ledgerPath')),
    });
  } catch (error) {
    warn(`the core could not be built, every module stays off: ${messageOf(error)}`);
    return;
  }

  const registry = createRegistry({ modules: MODULES, ctx, config: live, core });
  current = registry;

  // The credentials store mounts after this boot — measured on this host: the
  // status route reported `configured: false` while the probe, which refreshes
  // first, returned a real probability. A module that asks the judge anyway would
  // recover by itself, but the ones that check `configured` before asking would
  // not: they fail open in silence, which is the whole cost of this gap. So the
  // credential is re-resolved when the service appears, and once more before any
  // judgment that still finds it missing.
  try {
    ctx.inject(['credentials'], () => {
      void Promise.resolve(credential.refresh()).catch((error) => {
        warn(`the credential was not re-resolved when the store mounted: ${messageOf(error)}`);
      });
    });
  } catch (error) {
    warn(`the credentials service could not be awaited: ${messageOf(error)}`);
  }

  try {
    const judge = core?.judge;
    if (judge && typeof judge.ask === 'function' && typeof credential?.refresh === 'function') {
      const ask = judge.ask.bind(judge);
      let resolving = null;
      judge.ask = async (...args) => {
        if (judge.configured !== true) {
          resolving ??= Promise.resolve(credential.refresh()).catch(() => {});
          try {
            await resolving;
          } finally {
            resolving = null;
          }
        }
        return ask(...args);
      };
    }
  } catch (error) {
    warn(`the judge could not be given a credential retry: ${messageOf(error)}`);
  }

  try {
    await registry.start();
  } catch (error) {
    // An impossible composition (two enabled owners on one exclusive seam, an
    // unknown seam) rejects start(). The entry stays active and reports it.
    warn(messageOf(error));
  }

  // The settings page is generated from `Config`. No settings service, no page;
  // the plugin still runs.
  try {
    const settings = ctx?.get?.('settings');
    if (typeof settings?.configure === 'function') {
      ctx.effect(() => settings.configure({ auto: true }), 'dsh-jev-layer: settings page policy');
    }
  } catch (error) {
    warn(`the settings page was not wired: ${messageOf(error)}`);
  }

  // A runtime toggle is a volatile write. `settings.update` writes through the
  // references in place, so the registry only has to read the switches again.
  const namespace = readConfig(live, 'namespace', name);

  // ── the status and settings routes ─────────────────────────────────────
  //
  // The settings page is the settings service's own surface, and this route is
  // the same write path (`settings.update`) exposed over HTTP so that an
  // operator, or a gate, can toggle a module and then read what happened. A host
  // with no web server still gets every module; only these two reads go away.
  let disposeRoutes = null;
  try {
    ctx.inject(['webServer'], (scoped) => {
      disposeRoutes = registerRoutes(scoped, {
        namespace,
        live,
        registry,
        core,
        credential,
        refreshCredential: () => credential.refresh(),
        warn,
      });
    });
  } catch (error) {
    warn(`the status route was not wired: ${messageOf(error)}`);
  }

  try {
    ctx.on(SETTINGS_UPDATED, (ns) => {
      if (ns !== name && ns !== namespace) return;
      // Re-resolve first: the write may have changed `apiKeyRef`, and the next
      // judgment must see the credential the new name denotes.
      void (async () => {
        await credential.refresh();
        await registry.applyConfig(live);
      })().catch((error) => warn(`a settings change was not applied: ${messageOf(error)}`));
    });
  } catch (error) {
    warn(`runtime toggling is not wired: ${messageOf(error)}`);
  }

  try {
    ctx.effect(() => () => {
      if (typeof disposeRoutes === 'function') disposeRoutes();
      void registry.stop();
    }, 'dsh-jev-layer: teardown');
  } catch {
    /* A host without effects still gets the row; unloading is then a hard stop. */
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The credential the judge authenticates with.
 *
 * Why this exists at all. The config exposes `apiKeyRef`, the *name* of a
 * credential; the core reads `SETTING_KEYS.apiKey`, the *value*. Without a
 * resolution step between them the judge is unconfigured in a live host and
 * every module silently fails open — which is exactly the defect this file now
 * fixes. The pattern is the one verified on this host by
 * `/home/sil/dsh-forks/dsh-jev-router/lib/index.js` (`resolveApiKey`): the DSH
 * credentials service first, then the process environment.
 *
 * The contract this keeps:
 *   - the value is cached in this closure, so {@link createSettings} can answer
 *     `get('apiKey')` synchronously;
 *   - `refresh()` is re-run whenever the config changes, so a corrected
 *     `apiKeyRef` reaches the next judgment without a restart;
 *   - the value is never logged, never persisted and never put in a response —
 *     `state()` is the masked form for status output.
 *
 * @param {object} ctx the Cordis context.
 * @param {object} live the loader's config object (volatile fields inside).
 * @param {(message: string) => void} warn a logger that must never be the failure.
 */
export function createCredential(ctx, live, warn) {
  let value;
  let ref = null;
  let source = null;

  async function refresh() {
    const name = readConfig(live, 'apiKeyRef', GLOBAL_DEFAULTS.apiKeyRef);
    ref = typeof name === 'string' && name !== '' ? name : null;
    source = null;
    value = undefined;
    try {
      const credentials = ctx?.get?.('credentials');
      if (credentials?.resolve && ref !== null) {
        const resolved = await credentials.resolve(ref);
        if (typeof resolved?.value === 'string' && resolved.value !== '') {
          value = resolved.value;
          source = resolved.source ?? 'credential store';
          return state();
        }
      }
    } catch (error) {
      // An unavailable credentials service is not fatal: the environment layer
      // below is the documented fallback. The message names the ref, never a value.
      warn(`the credential "${String(ref)}" could not be resolved from the store: ${messageOf(error)}`);
    }
    const fromEnv = ref === null ? undefined : process.env?.[ref];
    // `||`, not `??`: the router's layering falls through a blank env var too.
    const fallback = fromEnv || process.env?.TYPESAFE_API_KEY;
    if (typeof fallback === 'string' && fallback !== '') {
      value = fallback;
      source = 'environment';
    }
    return state();
  }

  /** The masked credential state. A ref and a source; never the value. */
  function state() {
    return { ref, configured: typeof value === 'string' && value !== '', source };
  }

  return {
    refresh,
    state,
    /** The synchronous read {@link createSettings} wraps. */
    read() {
      return value;
    },
  };
}

/** The path prefix these two routes live under. */
export const ROUTE_PREFIX = '/dsh-jev-layer';

/** The probe's own deadline; a judgment is still a network call. */
const PROBE_TIMEOUT_MS = 30_000;

/** Answer one request with JSON, and never let a write grow past 64 KB. */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Read a small JSON body. */
function readBody(request, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Register `GET /dsh-jev-layer/status`, `POST /dsh-jev-layer/settings` and
 * `POST /dsh-jev-layer/probe`.
 *
 * The status read is what proves activation: the loader row reports *mounted*
 * even when the core failed to load and every module stayed off, so a row that
 * says "active" is not evidence that anything works. These modules, each with
 * its `started` flag and its error, are.
 *
 * The probe is what proves the judge is wired: a configured flag can be true
 * while the credential never resolved, so one real judgment — a trivial `noul`
 * question against the configured endpoint — is the honest observation.
 */
export function registerRoutes(scoped, { namespace, live, registry, core, credential, refreshCredential, warn }) {
  const webServer = scoped?.get?.('webServer');
  if (typeof webServer?.register !== 'function') return null;
  const disposers = [];

  const snapshot = () => {
    let ledger = null;
    try {
      ledger = typeof core?.ledger?.size === 'function' ? { size: core.ledger.size() } : null;
    } catch {
      ledger = null;
    }
    return {
      id: name,
      namespace,
      modules: registry.state(),
      started: registry.state().filter((state) => state.started).map((state) => state.id),
      ledger,
      judge: {
        configured: core?.judge?.configured === true,
        endpoint: core?.judge?.endpoint ?? null,
        model: core?.judge?.model ?? null,
      },
      // Masked on purpose: a ref, a source and a boolean. Never the value, and
      // never any part of it.
      credential: credential?.state?.() ?? null,
    };
  };

  /**
   * The skills service a module api hands out right now.
   *
   * Read through the registry, not through `scoped`, so the probe observes the
   * exact resolution a module gets rather than a second lookup beside it.
   */
  const skillsAvailable = () => {
    try {
      return registry?.skillsService?.() !== undefined;
    } catch {
      return false;
    }
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      try {
        sendJson(response, 200, snapshot());
      } catch (error) {
        sendJson(response, 500, { error: messageOf(error) });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/settings`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      try {
        const body = await readBody(request);
        const patch = body?.patch;
        if (patch === null || typeof patch !== 'object') {
          sendJson(response, 400, { ok: false, error: 'expected { patch: { ... } }' });
          return;
        }
        const settings = scoped?.get?.('settings');
        if (typeof settings?.update !== 'function') {
          sendJson(response, 503, { ok: false, error: 'the host has no settings service' });
          return;
        }
        await settings.update(namespace, patch);
        // The service emits `settings/document-updated`, which is what the boot
        // wired to `applyConfig`. Nothing is assigned into `live` here: a
        // volatile field is updated in place by the service, and replacing the
        // reference with a plain value would cut the field off from the
        // settings system for the rest of the process.
        // The patch may have changed `apiKeyRef`, so the credential is
        // re-resolved before anything reads it.
        try {
          await refreshCredential?.();
        } catch (error) {
          warn(`the credential was not re-resolved after a settings write: ${messageOf(error)}`);
        }
        await registry.applyConfig(live);
        sendJson(response, 200, { ok: true, patch, ...snapshot() });
      } catch (error) {
        warn(`a settings write failed: ${messageOf(error)}`);
        sendJson(response, 409, { ok: false, error: messageOf(error) });
      }
    },
  }));

  // ── the probe ────────────────────────────────────────────────────────────
  //
  // One trivial question, so the answer is comparable between runs and costs
  // almost nothing. Its whole point is that a probability can only come back
  // from the configured endpoint: a `configured: true` flag never can.
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/probe`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      try {
        // The credentials service may not have been mounted when the boot ran,
        // so the probe re-resolves before it reads the flag. This never returns
        // the value; it only moves it into the cached reader.
        try {
          await refreshCredential?.();
        } catch (error) {
          warn(`the credential was not re-resolved before the probe: ${messageOf(error)}`);
        }
        // The call always goes through the core, configured or not: an
        // unconfigured judge answers `null` itself, without a request, and
        // records `lastError.kind === 'unconfigured'`. That is the verdict the
        // gate reads; deciding here instead would leave the reason stale.
        let answers = null;
        try {
          answers = await core?.judge?.ask?.(
            'The sky is blue on a clear day.',
            { probe: { type: 'noul', instructions: 'Is the statement true?' } },
            { featureId: 'probe', timeoutMs: PROBE_TIMEOUT_MS, failOpen: 'report-unavailable' },
          ) ?? null;
        } catch (error) {
          warn(`the probe's judgment threw: ${messageOf(error)}`);
        }
        const configured = core?.judge?.configured === true;
        const answer = answers?.probe;
        const raw = typeof answer === 'number' ? answer : answer?.noul ?? answer?.probability;
        const probability = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        sendJson(response, 200, {
          ok: configured && probability !== null,
          configured,
          probability,
          probabilities: probability === null ? {} : { probe: probability },
          lastError: core?.judge?.lastError ?? null,
          lastErrorKind: core?.judge?.lastError?.kind ?? null,
          endpoint: core?.judge?.endpoint ?? null,
          model: core?.judge?.model ?? null,
          credential: credential?.state?.() ?? null,
          // Defect 2, observed live: a module api must hand out a usable skills
          // service, not `undefined`.
          skills: skillsAvailable(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: messageOf(error) });
      }
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* A route that is already gone must not keep the rest from unloading. */
      }
    }
  };
}
