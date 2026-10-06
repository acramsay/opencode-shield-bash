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
bun run test:integration  # spawns a real opencode against a local mock provider; skips if the binary is absent
```

Run `typecheck` and `test` after any change to `src/`. CI runs both on every push and PR; it
skips `test:integration` deliberately (see `.github/workflows/ci.yml`) since it needs a live
server and provider credentials — that suite is local/opt-in.

## Local plugin development

`opencode.json` at the repo root loads this plugin from source and disables the published
package:

```json
{
  "plugins": [
    "-shield-bash",
    { "package": "./src/dev", "options": { "providerID": "openrouter", "modelID": "z-ai/glm-5.3-flash", "failure": "deny" } }
  ]
}
```

`src/dev/index.ts` is a thin entrypoint over `src/index.ts` that registers under the id
`shield-bash-dev`. V2 rejects two plugins with the same id, and the published package claims
`shield-bash`, so the dev entry needs its own id to load alongside it. The `-shield-bash` control
disables the inherited published entry; without it the published plugin wins and the source entry
fails with `Duplicate plugin ID: shield-bash`. The `src/dev/` directory is not in `package.json`
`files`, so it is never published.

V2 resolves a local plugin entry as a **directory** and loads its `index.ts`. A bare
`@scope/name@file:.` npm spec does not work here — the loader reports `Plugin entrypoint not
found`. Just run `opencode` from this directory; no separate setup needed.

The plugin reads its configuration from `ctx.options`, so the object form (with `options`) is
required. The provider/model in this file only affects interactive use of the repo — the test
suite configures its own mock provider and never reads this file.

Edits to `src/` take effect on the next opencode restart; config is read once at startup, so
restart opencode after changing `src/`, `opencode.json`, or any other config file.

Two commands help verify this kind of thing directly rather than guessing from source:

- `opencode debug config` — lists the configuration documents and directories OpenCode merged,
  with their paths (which files contributed, in order)
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
Both breaking forms are recognized — `feat!:`/`fix!:` and a `BREAKING CHANGE:` footer — because
the `conventionalcommits` preset is configured explicitly (the default `angular` preset ignores
the `!`). Never push a `v*` tag by hand, and never publish from a local machine — see README.md
"Releases" for details.
