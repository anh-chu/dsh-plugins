/**
 * Configuration: one schema, one resolver, no raw reads.
 *
 * Two facts force this layer to exist.
 *
 * 1. A `volatile` field does not arrive as a bare value. The schema resolves it
 *    to an immutable reference object with `get()` (schemastery's
 *    `createVolatile`). Reading `config.x` therefore yields `{}`, and
 *    `config.x === true` is silently false for every switch in the plugin. Every
 *    read must go through {@link readConfig}.
 *
 * 2. `@deepseek-ai/schemastery` may not resolve at all: a plugin installed by a
 *    `file:` link depends on the host's in-memory resolver, and this repository
 *    has no `node_modules`. When the import fails the plugin must still work —
 *    Cordis skips config validation when `Config` is `undefined`, and the loader
 *    still passes the configured object to `apply()`.
 *
 * The schema shape is one plain object per module id, with volatile leaves:
 *
 *   config['screen.fetch'].enabled
 *   config['screen.fetch'].threshold
 *
 * Module ids contain a dot, so a flat `id.setting` key would be ambiguous to
 * read by eye and awkward to patch from a settings form. The id is a literal
 * top-level key instead, and the registry never parses a config path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Global field defaults. These names are not fixed by docs/CONTRACT.md; the core
 * reads them through the `settings` reader it is given, so the two sides must
 * agree on this set. Reported to the integrator as a contract gap.
 */
export const GLOBAL_DEFAULTS = Object.freeze({
  /** Loader entry id, and therefore the settings namespace. Frozen by cordis.patch.yml. */
  namespace: 'dsh-jev-layer',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKeyRef: 'TYPESAFE_API_KEY',
  /** Judge calls allowed per turn across every module. */
  turnCeiling: 20,
  /** 'shadow' records the would-be decision and acts on nothing; 'enforce' acts. */
  mode: 'shadow',
  /** Notification transports. Empty means the transport is off. */
  notifyUrl: '',
  notifyCommand: '',
  /**
   * Where judgments are appended as JSONL. Empty keeps the ledger in memory,
   * which means every record is gone when the host exits — and that makes shadow
   * mode's promise unreadable after the fact.
   */
  ledgerPath: '',
});

/** Per-field description shown in the generated settings page. */
const GLOBAL_DESCRIPTIONS = Object.freeze({
  namespace: 'Loader entry id, which is also the settings namespace. Must match the id in cordis.patch.yml.',
  endpoint: 'Judge endpoint. The default is the TypeSafe System One route; a compatible route (for example https://opencode.ai/zen/v1/systemone) can serve the same key.',
  model: 'Judge model name. Empty or default means jev-latest, which only the TypeSafe host serves.',
  apiKeyRef: 'Name of the credential that holds the judge API key. The key itself stays in the DSH credential store.',
  turnCeiling: 'Judge calls allowed per turn, shared by every module. The answering feature outranks pruning when the ceiling is reached.',
  mode: 'Default mode for every module: shadow records the would-be decision and acts on nothing; enforce acts.',
  notifyUrl: 'Notification transport: an HTTPS POST to this URL. Empty disables the transport.',
  notifyCommand: 'Notification transport: a shell command with the message substituted. Empty disables the transport.',
  ledgerPath: 'Path to a JSONL file where every judgment is appended. Empty keeps the ledger in memory, which is lost when the host exits; set it so shadow-mode records survive for later comparison.',
});

/** The declarative setting types a module may use in its `settings` map. */
export const SETTING_TYPES = Object.freeze(['boolean', 'number', 'string', 'stringArray']);

/**
 * The settings key the core reads for its credential — `SETTING_KEYS.apiKey` in
 * `packages/core/src/settings.js`, whose exact value is `'apiKey'`.
 *
 * It is deliberately not a member of {@link GLOBAL_DEFAULTS}: that map drives
 * the generated settings page, and the key value must never be a config value.
 * The name of the credential is `apiKeyRef`; the value comes from the DSH
 * credential store and is held only in memory.
 */
export const API_KEY_SETTING = 'apiKey';

/**
 * The schema library, or `null` when it cannot be reached.
 *
 * Loaded through three roots, in this order, because the first one is the only
 * one a registry install needs and the only one a `link:` install cannot use:
 *
 *   1. the bare specifier — the profile's own `node_modules`, which a plugin
 *      installed from a registry resolves through;
 *   2. the harness entry point Node was started with, then `@deepseek-ai/dsh`
 *      from there — the install's own copy;
 *   3. any profile under `$DSH_HOME/profiles`, which is where the host keeps the
 *      library in a `link:` deployment.
 *
 * Why this is not laziness. A plugin installed with `link:` has no
 * `node_modules` anywhere above its real path, so the bare import fails while the
 * host has the library all along. `Config` then becomes `undefined`, and that
 * costs more than a lost schema: the settings service refuses to configure an
 * entry without one. Measured on this host — `settings.update` returned
 * `No configurable plugin entry "dsh-jev-layer"`, so the plugin had no settings
 * page and its own settings route could not write, while every gate stayed green
 * because the gates install with `file:`, where the bare specifier resolves.
 */
async function loadSchemastery() {
  const candidates = ['@deepseek-ai/schemastery'];
  try {
    const { createRequire } = await import('node:module');
    const entry = process.argv[1];
    if (typeof entry === 'string' && entry !== '') {
      try {
        const pkg = createRequire(entry).resolve('@deepseek-ai/dsh/package.json');
        candidates.push(createRequire(pkg).resolve('@deepseek-ai/schemastery'));
      } catch {
        // The entry point is a convenience, not a requirement.
      }
    }
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (typeof home === 'string' && home !== '') {
      const profiles = join(home, '.dsh', 'profiles');
      for (const name of readdirSync(profiles)) {
        const root = join(profiles, name, 'node_modules');
        try {
          if (existsSync(join(root, '@deepseek-ai', 'schemastery'))) {
            candidates.push(createRequire(join(root, 'index.js')).resolve('@deepseek-ai/schemastery'));
            break;
          }
        } catch {
          // An unreadable profile is simply not a candidate.
        }
      }
    }
  } catch {
    // Resolution roots are best-effort; the bare specifier above still works.
  }
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      return mod.default ?? mod;
    } catch {
      // Try the next root.
    }
  }
  return null;
}

const schemastery = await loadSchemastery();

export { schemastery };

/**
 * One volatile leaf.
 *
 * `.default()` must come before `.volatile()`: `volatile()` wraps the schema's
 * resolved value in a reference, and the default is what a fresh install
 * resolves to.
 */
function leaf(lib, spec, description) {
  let schema;
  switch (spec?.type) {
    case 'boolean':
      schema = lib.boolean();
      break;
    case 'number':
      schema = lib.number();
      break;
    case 'stringArray':
      schema = lib.array(lib.string());
      break;
    case 'string':
      schema = lib.string();
      break;
    default:
      // An unknown type is a module's programming error. It must not take the
      // whole settings page down, so the field is kept, untyped.
      schema = lib.any();
      break;
  }
  if (spec?.default !== undefined) schema = schema.default(spec.default);
  schema = schema.volatile();
  if (description) schema = schema.description(description);
  return schema;
}

/**
 * Build the Config schema: the global fields plus one plain object per module,
 * holding a volatile `enabled` boolean and the module's own volatile settings.
 *
 * Returns `undefined` when the schema library is unavailable, which is the
 * documented degradation: Cordis skips validation and the plugin still works.
 *
 * @param {Array<{id: string, settings?: Record<string, object>}>} modules
 * @param {object|null} [lib] schema library; injected by tests
 */
export function buildConfig(modules, lib = schemastery) {
  if (!lib) return undefined;
  const fields = {};
  for (const [key, default_] of Object.entries(GLOBAL_DEFAULTS)) {
    const type = typeof default_ === 'boolean' ? 'boolean' : typeof default_ === 'number' ? 'number' : 'string';
    fields[key] = leaf(lib, { type, default: default_ }, GLOBAL_DESCRIPTIONS[key]);
  }
  for (const module of Array.isArray(modules) ? modules : []) {
    const id = module?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const settings = {};
    // The registry owns the toggle, including its default. A module may not
    // make itself on at install time, and may not redefine the field.
    // The module's one-line purpose rides on this switch. The settings mirror
    // projects each module object through `volatileForm`, which rebuilds a
    // non-volatile object from its children and drops the object's own description
    // (measured: it survives on the built schema and is gone from the mirror's
    // form). A volatile leaf is kept whole, so the purpose is carried where it
    // is not discarded.
    // The readable name is carried on the same leaf, as `title`, so the panel can
    // show "Trim large command output" under the heading instead of the raw id.
    const enabledLeaf = leaf(
      lib,
      { type: 'boolean', default: false },
      typeof module.description === 'string' && module.description !== ''
        ? module.description
        : `Enable ${id}. Off on a fresh install.`,
    );
    if (typeof module.label === 'string' && module.label !== '') enabledLeaf.meta.title = module.label;
    settings.enabled = enabledLeaf;
    for (const [name, spec] of Object.entries(module.settings ?? {})) {
      if (name === 'enabled') continue;
      settings[name] = leaf(lib, spec, spec?.description);
    }
    fields[id] = lib.object(settings);
  }
  return lib.object(fields);
}

/** A volatile reference is an object with a `get()`, never a bare value. */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function';
}

/**
 * Read one configuration value, unwrapping a volatile reference.
 *
 * A released or broken reference falls back rather than throwing: a failed
 * config read must not interrupt a user request.
 */
export function readConfig(config, key, fallback) {
  if (!config || typeof config !== 'object') return fallback;
  const raw = config[key];
  if (raw === undefined || raw === null) return fallback;
  if (isVolatileRef(raw)) {
    try {
      const value = raw.get();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return raw;
}

/** Whether a module is switched on. Absent means off, which is the install default. */
export function isModuleEnabled(config, id) {
  return readConfig(config?.[id], 'enabled', false) === true;
}

/**
 * The reader handed to the core. Global keys only; values are already unwrapped.
 *
 * `apiKey` is the one key that is not read from the config object. The config
 * exposes `apiKeyRef`, the *name* of a credential; the value is resolved out of
 * band (the deferred boot owns that, through the host's credentials service) and
 * held in a closure there. `apiKey` is answered from that closure, synchronously,
 * because the core reads it on every judgment and must see a re-resolution
 * without a restart.
 *
 * @param {object} config the loader's config object.
 * @param {string | (() => string | undefined)} [apiKey] the resolved credential
 *   value, or a getter for it. Absent means no credential resolves.
 */
export function createSettings(config, apiKey) {
  return {
    get(key) {
      if (key === API_KEY_SETTING) {
        const value = typeof apiKey === 'function' ? apiKey() : apiKey;
        if (typeof value === 'string' && value !== '') return value;
        // Fall through: a config that one day holds a literal `apiKey` still wins.
      }
      return readConfig(config, key, nestedKey(config, key, GLOBAL_DEFAULTS[key]));
    },
  };
}

/**
 * Resolve a core key written `<module id>.<field>` against the nested config.
 *
 * The core asks for per-feature overrides as flat dotted keys (`answer.questions.mode`,
 * `admit.output.budget`, `rank.files.priority`), but the real config nests them:
 * `config['answer.questions'].mode`. Module ids contain a dot themselves, so the split
 * is at the LAST dot. Before this, no per-module `mode`, `budget` or `priority` could
 * ever reach the core, and `answer.questions`, which defaults to shadow, could never
 * leave it: a real turn with `mode: enforce` under that module still recorded `shadow`.
 * A flat key in the config still wins, so existing flat settings keep working.
 *
 * @returns {unknown} the nested value, or `fallback` when there is none.
 */
function nestedKey(config, key, fallback) {
  const cut = typeof key === 'string' ? key.lastIndexOf('.') : -1;
  if (cut <= 0 || !config || typeof config !== 'object' || config[key] !== undefined) return fallback;
  const section = config[key.slice(0, cut)];
  if (!section || typeof section !== 'object') return fallback;
  return readConfig(section, key.slice(cut + 1), fallback);
}

/**
 * The reader handed to one module, through `api.config`.
 *
 * It reads the registry's *current* config object on each call, so a runtime
 * settings write is visible without rebuilding anything.
 *
 * @param {() => object} getLive
 * @param {string} id
 */
export function createModuleConfig(getLive, id) {
  return {
    get(key) {
      return readConfig(getLive()?.[id], key);
    },
  };
}
