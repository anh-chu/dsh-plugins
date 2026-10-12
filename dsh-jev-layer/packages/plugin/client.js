/**
 * `dsh-jev-layer` browser half: one tab in Settings -> Plugins.
 *
 * Why this file has to exist at all. In DSH 0.2 a plugin cannot register a
 * settings page from the host: both namespace registration faces were removed,
 * each loader entry's own `Config` *is* the settings document, and the Plugins
 * section is the client list slot `settings.plugins.tab`. A host-only plugin
 * therefore has no page of its own — it appears only in the generic inventory.
 *
 * What it renders is the host's own form, not a copy: `configForms.get(entryId)`
 * is keyed by the loader entry id, reads through the shared describe mirror and
 * queues writes over the host's settings transport. Nothing here re-implements
 * validation or persistence.
 *
 * Layout is data-driven: the entry's section is one key per module plus the
 * global fields, so the panel reads whatever keys the snapshot has rather than
 * carrying a list that can drift from the barrel.
 *
 * Every field's help text comes from the plugin's own schema — each setting was
 * declared with a `description`, and `configForms.describe()` carries the
 * serialized schema — because the first version of this panel showed bare field
 * names and the operator's words were "how am I supposed to know what does what".
 * The answer was already written; it just was not being read.
 */
window.__ModuleLoader__.load({
  id: 'dsh-jev-layer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** The loader entry id, which is also the settings namespace and the form key. */
    const ENTRY_ID = 'dsh-jev-layer';
    /** Where the Plugins section collects its tabs. */
    const TAB_SLOT = 'settings.plugins.tab';
    /** Tab order: after the shipped entries (10, 30, 50, 60, 130). */
    const TAB_ORDER = 70;

    const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const isScalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

    /** `minTokens` -> `Min tokens`. A schema title, when one exists, wins over this. */
    /** Words, not identifiers: `select.skill` -> `Select skill`, `minTokens` -> `Min tokens`. */
    const humanize = (key) => key
      .replace(/[._-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());

    /**
     * Walk a serialized schemastery schema into `path -> { title, description, default }`.
     *
     * The envelope is `{ uid, refs }` — the root node is `refs[uid]`, and a `dict`
     * maps a name to EITHER a nested node or a ref id that resolves in `refs`. The
     * first version of this walk expected a plain nested `dict` tree, which is an
     * invented shape: the live panel showed no help text at all while its gate
     * passed on a fixture invented the same way. The real shape, read from
     * `Config.toJSON()`:
     *
     *     {"uid":307,"refs":{"43":{"type":"number","meta":{"default":2000,
     *      "volatile":true,"description":"Only judge tool results estimated
     *      above this many tokens."}}}, ...}
     *
     * The envelope comes from `JSON.stringify`, so it is acyclic; an unknown shape
     * is skipped rather than thrown on.
     */
    function collectFields(envelope, out = new Map()) {
      const refs = isPlainObject(envelope?.refs) ? envelope.refs : {};
      const nodeOf = (value) => {
        if (typeof value === 'number' || typeof value === 'string') return refs[value];
        return isPlainObject(value) ? value : undefined;
      };
      const record = (node, path) => {
        if (path.length === 0) return;
        const meta = isPlainObject(node.meta) ? node.meta : undefined;
        const entry = out.get(path.join('.')) ?? {};
        const title = meta?.title ?? node.title;
        const description = meta?.description ?? node.description;
        if (typeof title === 'string' && title !== '') entry.title = title;
        if (typeof description === 'string' && description !== '') entry.description = description;
        const fallback = meta?.default ?? node.default;
        if (fallback !== undefined) entry.default = fallback;
        if (Object.keys(entry).length > 0) out.set(path.join('.'), entry);
      };
      /**
       * Names under a node, from either rendering of the schema.
       *
       * The settings mirror serves the serialized schemastery envelope (`dict`
       * plus `meta`), while the harness's own Config projection is JSON Schema
       * (`properties` plus `description`). Measured on this host: the walk found
       * 88 fields in the first shape and ZERO in the second, so guessing one of
       * them is always wrong somewhere. Both are read, because the cost of
       * guessing has been a settings page with no help text three times.
       */
      const childrenOf = (node) => {
        if (isPlainObject(node.dict)) return node.dict;
        if (isPlainObject(node.properties)) return node.properties;
        return undefined;
      };
      const visit = (node, path) => {
        if (!isPlainObject(node)) return;
        record(node, path);
        for (const key of ['anyOf', 'oneOf', 'allOf']) {
          if (Array.isArray(node[key])) for (const branch of node[key]) visit(branch, path);
        }
        if (Array.isArray(node.items)) for (const item of node.items) visit(item, path);
        else if (isPlainObject(node.items)) visit(node.items, path);
        const children = childrenOf(node);
        if (children === undefined) return;
        for (const [key, child] of Object.entries(children)) visit(nodeOf(child), [...path, key]);
      };
      visit(nodeOf(envelope?.uid), []);
      // A projected schema has no `uid`; start from the document itself then.
      if (out.size === 0 && isPlainObject(envelope) && envelope.uid === undefined) visit(envelope, []);
      return out;
    }

    /** This plugin's schema, out of the shared describe mirror. */
    function schemaFields(describe) {
      let view;
      try {
        view = describe?.getSnapshot?.()?.view;
      } catch {
        view = undefined;
      }
      const own = Array.isArray(view?.namespaces)
        ? view.namespaces.find((namespace) => namespace?.ns === ENTRY_ID)
        : undefined;
      return collectFields(own?.schema);
    }

    /** Theme tokens only: the same variables the harness's own settings pages read. */
    const TOKEN = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      hairline: 'var(--dsw-alias-border-l3)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      radius: 'var(--dsw-radius-md)',
    };

    /** Muted explanation under a label. */
    function Help({ text }) {
      if (typeof text !== 'string' || text === '') return null;
      return h('p', { style: { margin: '0.3rem 0 0', fontSize: '0.85rem', lineHeight: 1.5, color: TOKEN.secondary } }, text);
    }

    /** One labelled setting: name, explanation, and an input on the right. */
    function Row({ title, help, children }) {
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(12rem, 18rem)',
          gap: '1.5rem',
          alignItems: 'center',
          padding: '1rem 0',
          borderTop: `1px solid ${TOKEN.hairline}`,
        },
      },
        h('div', null,
          h('div', { style: { color: TOKEN.primary, fontWeight: 500 } }, title),
          h(Help, { text: help })),
        h('div', null, children));
    }

    /** A text or number input styled as the host styles its own fields. */
    function Input({ name, value, title, onWrite }) {
      const text = value === null || value === undefined ? '' : String(value);
      const isNumber = typeof value === 'number';
      return h('input', {
        type: isNumber ? 'number' : 'text',
        defaultValue: text,
        'aria-label': title,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.45rem 0.6rem',
          borderRadius: TOKEN.radius,
          border: `1px solid ${TOKEN.border}`,
          background: TOKEN.surface,
          color: TOKEN.primary,
          font: 'inherit',
        },
        onBlur: (event) => {
          const raw = event.target.value;
          if (raw === text) return;
          onWrite(isNumber ? Number(raw) : raw);
        },
        name,
      });
    }

    /** On / off as a two-choice segmented control, the same pattern the page uses. */
    function Switch({ on, label, onToggle }) {
      const choice = (value, text) => h('button', {
        type: 'button',
        'aria-pressed': on === value,
        'aria-label': `${label}: ${text}`,
        onClick: () => { if (on !== value) onToggle(value); },
        style: {
          padding: '0.35rem 0.9rem',
          border: 'none',
          borderRadius: TOKEN.radius,
          cursor: 'pointer',
          font: 'inherit',
          background: on === value ? TOKEN.hover : 'transparent',
          color: on === value ? TOKEN.primary : TOKEN.tertiary,
        },
      }, text);
      return h('div', {
        role: 'group',
        'aria-label': label,
        style: { display: 'inline-flex', gap: '0.25rem', padding: '0.2rem', border: `1px solid ${TOKEN.border}`, borderRadius: TOKEN.radius },
      }, choice(false, 'Off'), choice(true, 'On'));
    }

    /** One module: a heading with its purpose, the enable switch, then its settings. */
    function ModuleBlock({ id, section, help, onToggle, onWrite }) {
      const enabled = section.enabled === true;
      const rows = Object.entries(section).filter(([key, value]) => key !== 'enabled' && isScalar(value));
      return h('section', { style: { padding: '1.25rem 0', borderTop: `1px solid ${TOKEN.border}` } },
        h('div', {
          style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '1.5rem', alignItems: 'start' },
        },
          h('div', null,
            h('h4', { style: { margin: 0, fontSize: '1rem', fontWeight: 600, color: TOKEN.primary } }, help?.title ?? humanize(id)),
            h(Help, { text: help?.description })),
          h(Switch, { on: enabled, label: `${id} enabled`, onToggle })),
        rows.length === 0 ? null : h('div', { style: { marginTop: '0.5rem' } },
          rows.map(([key, value]) => {
            const title = help?.fields?.get(`${id}.${key}`)?.title ?? humanize(key);
            return h(Row, {
              key,
              title,
              help: help?.fields?.get(`${id}.${key}`)?.description,
            }, h(Input, { name: key, value, title, onWrite: (next) => onWrite(key, next) }));
          })));
    }

    /** The one op a write sends: the exact leaf, as an array of keys. Pure, so a gate can check it. */
    function setOp(path, value) {
      return { op: 'set', path: Array.from(path), value };
    }

    function Panel({ form, describe }) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [fields, setFields] = React.useState(() => schemaFields(describe));
      const [error, setError] = React.useState(null);

      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
      React.useEffect(() => {
        if (typeof describe?.subscribe !== 'function') return undefined;
        describe.ensure?.();
        return describe.subscribe(() => setFields(schemaFields(describe)));
      }, [describe]);

      const section = isPlainObject(snapshot?.value)
        ? snapshot.value
        : (isPlainObject(snapshot?.base) ? snapshot.base : {});
      const modules = Object.entries(section).filter(([, value]) => isPlainObject(value));
      const globals = Object.entries(section).filter(([, value]) => isScalar(value));
      globals.sort(([a], [b]) => a.localeCompare(b));

      /**
       * Write one scalar field. `path` is an ARRAY of keys, never a dotted string.
       *
       * Module ids contain a dot (`admit.output`), and the schema keys the module section
       * by that whole id. Splitting `admit.output.enabled` on dots named the path
       * `['admit', 'output', 'enabled']`, which the host refused as "not volatile" for
       * every module whose id has a dot, so no module could be toggled from the page.
       * `form.mutate` takes path ops, so the exact leaf is named and the write is atomic
       * under one revision fence.
       */
      const write = (path, value) => {
        Promise.resolve(form.mutate([setOp(path, value)])).then(
          (accepted) => { if (accepted !== true) setError(`the host refused ${path.join(' / ')}`); },
          (failure) => setError(`${path.join(' / ')}: ${failure?.message ?? failure}`),
        );
      };

      if (snapshot?.status === 'unavailable') {
        return h('p', null, 'This entry is not served by the host, so it has no settings to show.');
      }

      /** One module's own help: its section description plus that section's fields. */
      const helpFor = (id) => {
        const inner = new Map();
        for (const [key, value] of fields) {
          if (key.startsWith(`${id}.`)) inner.set(key, value);
        }
        // The module's purpose is carried on its `enabled` switch (see config.js).
        const purpose = fields.get(`${id}.enabled`);
        return { title: purpose?.title, description: purpose?.description, fields: inner };
      };

      const enabled = modules.filter(([, value]) => value.enabled === true).length;

      const summary = `${enabled} of ${modules.length} modules are on. Changes apply live, without a restart.`;
      const sectionTitle = (text) => h('h3', {
        style: { margin: '1.75rem 0 0.25rem', fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: TOKEN.tertiary },
      }, text);

      return h('div', { style: { color: TOKEN.primary, maxWidth: '52rem' } },
        h('p', { style: { margin: '0 0 0.5rem', color: TOKEN.secondary, lineHeight: 1.5 } }, summary),
        error === null ? null : h('p', { role: 'alert', style: { color: TOKEN.error, margin: '0.5rem 0' } }, error),
        sectionTitle('Modules'),
        modules.length === 0
          ? h('p', { style: { color: TOKEN.secondary } }, 'The host reported no module sections yet.')
          : modules.map(([id, value]) => h(ModuleBlock, {
            key: id,
            id,
            section: value,
            help: helpFor(id),
            onToggle: (next) => write([id, 'enabled'], next),
            onWrite: (key, next) => write([id, key], next),
          })),
        sectionTitle('Global settings'),
        globals.map(([key, value]) => h(Row, {
          key,
          title: fields.get(key)?.title ?? humanize(key),
          help: fields.get(key)?.description,
        }, h(Input, {
          name: key,
          value,
          title: fields.get(key)?.title ?? humanize(key),
          onWrite: (next) => write([key], next),
        }))));
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY_ID);
        const describe = ctx.configForms.describe();
        ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
          name: TAB_SLOT,
          id: ENTRY_ID,
          order: TAB_ORDER,
          label: () => 'Jev layer',
        }, (props) => h(Panel, { ...props, form, describe })));
      },
      /**
       * Test hook: the schema walk, exposed because the panel cannot be rendered
       * without a DOM (this deployment ships no `react-dom/server`). The gate feeds
       * it a serialized schema and asserts the help text it produces, which is the
       * logic that decides whether the operator sees a description or a bare name.
       */
      __schemaFields: schemaFields,
      /** Test hook: the op a write sends, so a gate can assert a dotted module id stays one key. */
      __setOp: setOp,
    };
  },
});
