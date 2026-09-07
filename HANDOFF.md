# Handoff: opencode-shield-bash

Written 2026-09-07 at the end of a session in the owner's dotfiles repo
(`/Users/alexramsay/git/dotfiles`). This repo was created to turn a working, vendored opencode
plugin into a published npm package that opencode loads by name from the registry. It is seeded
with this document, an MIT LICENSE, and a README stub; everything else is Phase 1 below. You are
starting with an empty codebase and a finished reference implementation that lives in the
dotfiles repo.

## What shield-bash does

shield-bash gates every bash tool call by prompting a second opencode session with a fixed
policy prompt and acting on the JSON verdict through the `tool.execute.before` hook. The judge
session ("Shield Bash") is created as a child of the calling session, so the TUI's child-session
navigation reaches it, it stays out of the roots-only session list, and it is deleted with its
parent. Verdicts are cached in `~/.cache/shield-bash/verdicts.json` (TTL via
`SHIELD_BASH_TTL_HOURS`, default 24h, size-capped at 1000). The judge session transcript is the
audit trail; denials throw into the calling session.

Behavior is already documented in the source README. Read it first and adapt it for this repo:
`/Users/alexramsay/git/dotfiles/home/.config/opencode/plugins/shield-bash/README.md`

## Source of truth

Port the existing implementation from the dotfiles repo; treat it as the reference and preserve
its semantics. All files live under
`/Users/alexramsay/git/dotfiles/home/.config/opencode/plugins/shield-bash/`:

- `plugin.ts` — the hook, lazy config loading, judge session lifecycle, failure-mode glue
- `lib.ts` — `POLICY_PROMPT` (deny categories DG1–DG8), verdict parsing, cache read/save,
  default config
- `fixtures.json` — allow/deny fixture commands
- `test.ts` — integration test against a running `opencode serve`
- `README.md` — adapt into this repo's README

Dependency surface: type-only `@opencode-ai/plugin`; zero runtime npm dependencies. The code
uses Bun APIs (`Bun.file`, `Bun.write`), which is safe — opencode runs plugins under Bun.

## Runtime config — user-side, never shipped

The plugin reads `shield-bash.json` from the opencode config directory at runtime via
`client.path.get`. In the owner's dotfiles it lives at
`darwin/home/.config/opencode/shield-bash.json` (OS-specific layer) with
`{"providerID":"vercel","modelID":"zai/glm-5.3-flash","failure":"deny"}`. `SHIELD_BASH_MODEL`
("provider/model") overrides it; missing config falls back to the same model. Document the
config schema in this repo's README; keep the config file itself in the dotfiles repo.

`failure` decides behavior when the judge session errors: `deny` (default), `allow`, or `ask`
(defers to opencode's normal permission evaluation).

## Known upstream limitation — preserve the workaround

opencode's `permission.ask` hook is declared in `@opencode-ai/plugin` types but never triggered
by the server (issue [anomalyco/opencode#7006](https://github.com/anomalyco/opencode/issues/7006);
candidate PRs #30509, #42633, #19453). Binary allow/deny plus config-deferred `ask` is the
complete behavior space today; a tri-state `ask` that reinserts a permission prompt is future
work once upstream wires the hook. Keep `POLICY_PROMPT` and the DG categories unchanged.

## Decisions already made

These came out of the upstream session — treat them as settled constraints.

- Package name: `opencode-shield-bash`, unscoped. Verified free on npm.
- Repository: `github.com/acramsay/opencode-shield-bash`, public, under the personal `acramsay`
  account. Keep this project under the personal account — it is deliberately independent of any
  org (liatrio, liatrio-labs, or others).
- License: MIT, copyright "Alex Ramsay", 2026. The LICENSE file is already committed.
- Publishing runs in CI only. Never run `npm publish` from a local machine; the owner's local
  npm login is for verification commands (`npm whoami`, `npm view`), never for publishing.

## Phase 1 — build the package here

Work through these in order:

1. **Verify the plugin loading contract.** opencode.json's `"plugin"` array accepts npm package
   names. Confirm against opencode's docs and source how the package is resolved and which
   export is invoked. Two working precedents to inspect: `npm view opencode-pty` and
   `npm view @tarquinen/opencode-dcp` — both ship built JS in `dist/` with an `exports` map.
   Bun loads TypeScript natively, so shipping the TS entry directly may also work; confirm
   before choosing and prefer whichever option is simpler.
2. **Scaffold.** `package.json` (name `opencode-shield-bash`, version 0.1.0, `exports` per the
   verified contract, type-only dep on `@opencode-ai/plugin`), tsconfig, and a build step only
   if the contract requires compiled JS.
3. **Port the five files** listed above, with these test-path fixes — two dotfiles-layout
   assumptions break in this repo:
   - `test.ts` reads `join(here, "../../shield-bash.json")`, which resolves against the owner's
     opencode config dir in the dotfiles layout. Resolve the test config via an env var (e.g.
     `SHIELD_BASH_TEST_CONFIG`) or a committed test fixture, keeping the model overridable.
   - `test.ts` derives `directory = resolve(here, "../../../../..")` — the dotfiles repo root —
     for opencode's `?directory=` query param. Use this repo's root instead.
   - Preserve the remaining test behaviors: serial execution with a fresh judge session per
     fixture (a reused session recycles earlier reasoning into later verdicts), a 30s
     per-fixture timeout, and one retry to absorb provider flakiness.
4. **CI.** GitHub Actions workflow: install Bun, run tests, and on tag push publish with an
   `NPM_TOKEN` secret. Integration tests need a running `opencode serve` (default
   `http://localhost:4096`, overridable via `SHIELD_BASH_TEST_OPENCODE_URL`) and a provider API
   key, and they skip gracefully when the server is unreachable — so in CI run the
   unit-testable surface (`parseVerdictText`, cache read/save, prompt shape) and keep
   integration runs local/opt-in. Note the first-publish token nuance: npm granular access
   tokens are scoped to packages that already exist, so the initial 0.1.0 publish needs either
   a classic automation token or a broader granular token, rotating to a package-scoped
   granular token afterward. Surface the token choice to the owner — the tradeoff is theirs to
   make.
5. **Publish 0.1.0 from CI, then verify end-to-end.** Add `"opencode-shield-bash"` to a scratch
   opencode config's `"plugin"` array and confirm a fixture deny command is blocked.

## Phase 2 — dotfiles follow-up (out of scope here)

Once the package works from the registry, the dotfiles repo replaces its local shims
(`home/.config/opencode/plugins/shield-bash.ts` and the vendored `shield-bash/` directory) with
the npm entry in `home/.config/opencode/opencode.json`. The user-side `shield-bash.json` stays
in dotfiles. That work happens in a session in the dotfiles repo.

## Suggested skills

- `code-review` — before the first publish, review the port against the dotfiles original.
- `handoff` — when this phase completes or needs to move again.
- `unslop` — applies to any prose you write (README, workflow files, commit messages).
