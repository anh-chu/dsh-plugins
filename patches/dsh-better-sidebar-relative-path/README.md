# dsh-better-sidebar: serve relative paths in /sidebar/file

Upstream: `dsh-better-sidebar` 0.19.1 (also present in 0.21.1 — no upstream fix).
Repo: https://github.com/omdsh-dev/DSH-better-sidebar

## Bug

Clicking an inline tool file link (e.g. `.tmp/review/live/SIGNIN.png`) opens the
preview tab but the content never loads. The tab's `<img>` requests:

```
GET /sidebar/file?sessionId=...&path=.tmp%2Freview%2Flive%2FJOIN.png&cwd=%2Fhome%2Fsil%2Fseedwise%2Fapp
→ 400 {"ok":false,"error":{"code":"fs-error","message":"\".tmp/review/live/JOIN.png\" is not an absolute path"}}
```

The client (`src/client/api.ts:fileUrl`) sends the raw tool-arg path (relative)
plus a separate `cwd` query param, but the server (`ensureWorkspacePath` in
`src/path-security.ts`) runs `requireAbsolute` on the raw path before ever
using `cwd`, so every relative path is rejected. Absolute paths pass the check,
which is why only they open. Same latent bug in the `/sidebar/html` route
(shares `ensureWorkspacePath`).

## Fix (`dsh-better-sidebar@0.19.1.patch`)

`ensureWorkspacePath` joins workspace-relative targets onto `cwd` before the
absolute check — the same pattern the codebase already uses in `resolveGitPath`
(`requireAbsolute(join(cwd, raw))`). Absolute-path behavior is unchanged. The
realpath + `isWithin` fence still runs after the join, so `../../` escapes
still fail with 403 and missing files with 400. Applied to both `src/` and the
prebuilt `lib/` bundle (the runtime loads `lib/`).

Verified with node against real files: relative resolves, absolute unchanged,
existing outside file fenced out, missing file rejected.

## Install (web profile, pnpm `patchedDependencies` pattern)

```sh
cp dsh-better-sidebar@0.19.1.patch ~/.dsh/profiles/web/patches/
cd ~/.dsh/profiles/web
# add to pnpm-workspace.yaml:
#   dsh-better-sidebar@0.19.1: patches/dsh-better-sidebar@0.19.1.patch
pnpm install
```

Then reload `dsh web` so the host plugin picks up the patched `lib/`.
