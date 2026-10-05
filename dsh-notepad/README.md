# dsh-notepad

A persistent notepad plugin pinned to the DeepSeek Harness Web GUI (draggable, pinnable).

- Two scopes: a **global page** (shared by all sessions) + **this session's isolated page**, switchable or viewed side by side
- Input is autosaved to `~/.dsh/notepad/` (UTF-8 BOM, atomic write, revision optimistic locking, conflicts can be merged/overwritten)
- Failed saves retry automatically; unsaved content detected after a refresh can be restored in one click
- SSE live push + polling fallback; Markdown preview (checkboxes clickable), completion-rate stats, timestamp insertion, full-text search, history snapshots (20 archived automatically before each save), copy/download export
- Agent tools: `notepad_read` / `notepad_write` (append dedupes by line, optional timestamp) / `notepad_search` (cross-scope)
- The window can be dragged anywhere and locked in place; width is adjustable; auto-collapses on narrow screens; `Ctrl+Enter` saves immediately, `Esc` collapses
- Pure client-side styling using only `--dsw-*` theme tokens, following the light/dark theme

## Installation

```sh
dsh plugin --profile web add dsh-notepad
```

Restart dsh web and refresh the page. To uninstall: `dsh plugin --profile web remove dsh-notepad` (note files are kept by default).

### Local development

Keep the source **inside** the `~/.dsh/profiles/` tree (`link:` installs resolve dependencies upward from the plugin's realpath,
so outside that tree they cannot reach the host's bundled `@deepseek-ai/*` in `profiles/node_modules`):

```sh
# <yourProfileDir> is the actual path under ~/.dsh/profiles/
dsh plugin --profile web add link:<yourProfileDir>/dsh-notepad
```

## Structure

```
dsh-notepad/
├── package.json       # dsh.bundle + dsh.client (browser half)
├── cordis.patch.yml   # patch that inserts the host row into the composition
├── lib/
│   ├── index.js       # host half: storage/API/SSE + model tools
│   └── client.js      # browser half: shell.overlay persistent panel
```

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/api/notepad` | `?scope=global\|session&sessionId=&since=` read (returns `text:null` when unchanged) |
| PUT | `/api/notepad` | body `{ scope, sessionId?, text, baseRevision?, force? }`; conflicts return 409 |
| GET | `/api/notepad/stream` | SSE push: `{ scope, revision }` change broadcasts |
| GET | `/api/notepad/history` | `?scope=&sessionId=` history snapshot list |
| GET | `/api/notepad/history/<id>` | load a single snapshot |

## Local changes in this fork

This copy is a local fork of `dsh-notepad` 0.1.1, installed into the web profile with
`link:/home/sil/dsh-plugins/dsh-notepad`. It carries two deliberate divergences from upstream:

1. **Full English translation.** Every Chinese comment, tool description, model-facing output
   string, UI label and README line was translated. Behaviour is unchanged: the check is
   `node --check lib/index.js && node --check lib/client.js`, and the only edited lines are
   comments and string literals.
2. **A system-prompt section (`notepad:session`, order 1010).** Upstream nudges the model in no
   way at all - the tools exist but nothing says what the notepad is for or when to use it. The
   section states the use case, nudges both directions (write with `notepad_write` in append
   mode; read with `notepad_read` / `notepad_search` before answering about earlier work), draws
   the boundary against long-term memory, and renders the current session page itself so what was
   recorded comes back into context every turn without a read call. Only the newest
   `SECTION_MAX_BYTES` (2000) bytes are rendered, the trim is announced in the block, stored text
   cannot close the block early, and an agent-less assembly contributes nothing.
3. **Read-only inheritance for forked children.** A session forked from another (`session.header.parentSession`,
   set by `subagent_fork` and by session forks; a plain `subagent` spawn has no lineage and gets
   nothing) also renders its parent's page in a separate `<parent-notepad readonly>` block, capped
   at `PARENT_SECTION_MAX_BYTES` (1200). The parent's session id is deliberately not disclosed, so
   the tools cannot address that page, and `notepad_write` refuses it as a target regardless
   (`parentWriteRefusal`). Only one level of ancestry is visible: the parent's own parent is not
   reachable without a session lookup.

4. **The open Session is resolved for the frame-wide panel.** The panel registers into
   `shell.overlay`, a root-scope seat, and root-scope seats are handed no `sessionId`; the
   session-list snapshot in 0.2 has no `current` field either, so upstream's
   `useSessions((s) => s.current)` always returned undefined. The panel therefore stayed on the
   global page with its Session tab disabled ("Enter a session first"), while `notepad_write`
   defaulted to the session page — an agent could write nine lines and the panel showed nothing.
   A zero-render occupant of `conversation.input.left` (session scope, rendered whenever a Session
   is open) publishes `props.sessionId` into a module-level store the overlay panel subscribes to.
   The panel also now opens on the session page, matching the tools' default.

5. **Line-level removal, and a standing instruction to prune.** `notepad_write` gained
   `mode=remove` with `match=...`: every line containing that text (case-insensitive) is deleted
   and the count is reported; a match that hits nothing writes nothing. This exists because
   `mode=replace` cannot prune safely — the injected block shows only the newest
   `SECTION_MAX_BYTES`, so a rewrite built from what the model can see would silently discard the
   older lines it never saw. The prompt block now also tells the model to remove finished,
   resolved or superseded notes, so clearing happens as part of normal work rather than on
   request. Nothing expires on its own: pages have no TTL and no size cap.

Check for the section: `node tests/section.test.mjs`.

Do not reinstall this plugin by its npm name - `dsh plugin --profile web add dsh-notepad` would
restore the upstream package and drop all five changes. Re-add it by the `link:` path instead.
