# Agent Instructions

## What this is

An opencode plugin (`@acramsay/opencode-shield-bash`) that gates every `bash` tool call
through a second, judge session. See README.md for the full behavior, policy categories, and
config surface — this file covers working in the repo itself.

## Commands

```sh
bun install
bun run typecheck        # tsc --noEmit
bun run test              # bun test src/ — unit: verdict parsing, cache, prompt shape
bun run test:integration  # fixtures through a live judge; needs opencode serve + provider key, else skips
```

Run `typecheck` and `test` after any change to `src/`. CI runs both on every push and PR; it
skips `test:integration` deliberately (see `.github/workflows/ci.yml`) since it needs a live
server and provider credentials — that suite is local/opt-in.

## Local plugin development

`opencode.json` at the repo root already loads this plugin from source:

```json
{ "plugin": ["@acramsay/opencode-shield-bash@file:."] }
```

Just run `opencode` from this directory — no separate setup needed. This works, rather than
double-loading alongside a global npm install of the same plugin, because opencode's plugin
array is deduped by resolved package identity (npm name, or exact `file:` URL), not by the
literal spec string, and project config wins over global for the same identity. Confirmed via
`opencode debug config`: with a global npm entry for `@acramsay/opencode-shield-bash` already
present, adding this project config collapses to exactly one entry, sourced locally.

`file:` specs install as symlinks into `node_modules` (not copies), so edits to `src/` take
effect on the next opencode restart — no reinstall step. Config itself is read once at
startup, so restart opencode after editing `src/`, `opencode.json`, or any other config file.

Two commands help verify this kind of thing directly rather than guessing from source:

- `opencode debug config` — dumps the fully merged config, including `plugin_origins` (which
  file declared each plugin, and its resolved scope)
- `opencode debug paths` — shows resolved config/data/cache/state directories, including where
  env var overrides (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`) actually land

## Code conventions

- Comments are reserved for non-obvious intent or constraints (e.g. *why* a retry exists, *why*
  a lookup is memoized) — see the existing comments in `src/index.ts` and `src/lib.ts` for the
  bar. Do not add comments that restate the code.
- Strict TypeScript (`tsconfig.json`: `strict: true`). No emit; Bun runs the TS source directly,
  including in production (`package.json` ships `.ts` files, no build step).

## Releases

Trunk-based: work merges to `main`, and semantic-release runs in CI on every push to `main`.
Conventional commits drive version bumps (`feat` → minor, `fix` → patch, breaking → major).
Never push a `v*` tag by hand, and never publish from a local machine — see README.md
"Releases" for details.
