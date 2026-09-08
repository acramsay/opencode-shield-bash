# opencode-shield-bash

[opencode](https://opencode.ai) plugin that gates shell tool calls through a model judge.
The judge, prompted with a configurable safety policy, returns an allow/deny JSON verdict
before the command runs. Denials throw into the calling session, so the agent sees why the
command was blocked.

Supports OpenCode V2 beta and V1 1.18.29 or later from the same package.
The V2 API dependency is pinned to `@opencode/plugin@0.0.0-beta-19296`.
Keep this an exact version: a caret range can select the nonfunctional `0.0.0-reserved` package.
V2 uses tool-free text generation to judge `shell` (and legacy `bash`) tool calls.
It does not create judge sessions. Optional server audit files can retain judge
requests and responses without adding sessions to OpenCode.

On V1, the judge session is created lazily as a child of the calling session's root, titled "Shield Bash"
— one judge per root session, shared by that root's subagent sessions. That
matters for more than bookkeeping: it is reachable with the TUI's child-session navigation,
stays out of the roots-only session list, is deleted with its parent, and is never
auto-shared. The judge transcript doubles as the audit trail.

## Install

For V2, add the package to `plugins` in `opencode.json`:

```json
{ "plugins": ["@acramsay/opencode-shield-bash"] }
```

For V1 1.18.29 or later, use `plugin` instead:

```json
{ "plugin": ["@acramsay/opencode-shield-bash"] }
```

opencode installs npm plugins with Bun at startup. No build step: the package ships
TypeScript, which Bun loads natively.

## Config

### Settings dialog (V2 only)

1. Open the command palette and select **Configure Shield Bash**.
2. Select a setting and edit its draft value:

   | Setting | Action |
   | --- | --- |
   | **Judge model** | Enter `provider/model`, for example `vercel/zai/glm-5.3-flash`. Only the first slash separates the provider from the model ID. |
   | **On judge failure** | Choose `deny`, `ask`, or `allow`. This does not change how judge denials are handled. |
   | **Judge prompt** | Edit the policy in the TUI machine's `$EDITOR`. |
   | **Restore default prompt** | Remove the custom policy from the draft after confirmation. |
   | **Store judge conversations** | Turn server audit files on or off. The default is off. |

3. Select **Save** to write `shield-bash.json` on the connected server.
4. Restart that OpenCode service to apply the changes.

The settings apply globally on that server.
**Cancel** or Escape from the settings menu discards edits. Escape from a native
field dialog returns to the menu without changing that field. To leave `$EDITOR`,
use that editor's quit command.

The dialog shows when the server's `SHIELD_BASH_MODEL` or
`SHIELD_BASH_STORE_SESSIONS` environment variable overrides a saved setting.
Saving a setting does not remove an environment override.
Cache lifetime remains an environment-only setting.
V1 users must edit the configuration file instead.

**Judge prompt** opens the current policy in the TUI machine's `$EDITOR`, using a
private temporary Markdown file. Set `EDITOR` before starting OpenCode (for example,
`EDITOR=vi` or `EDITOR="code --wait"`). Editor arguments and quoted executable paths
are supported. GUI editors must wait until editing is complete. OpenCode suspends
its terminal UI while the editor runs and restores it afterward. A successful exit
updates only the settings draft; select **Save** to send it to the connected server.
An editor error or empty file leaves the draft unchanged. Temporary files are removed
after editing. This also works when the connected server is remote.

The edited prompt replaces the built-in safety policy. Keep the required JSON response format:
`{"decision":"allow"}` or `{"decision":"deny","reason":"..."}`.
Changing the policy can weaken protection. **Restore default prompt** restores
the built-in policy in the draft; select **Save** to remove the prompt override and
follow future built-in policy updates. Cancel discards
prompt edits along with other unsaved settings.

### Configuration file

The plugin reads `shield-bash.json` from your opencode config directory at runtime. It is
user-side configuration and never ships with the package.
On V2, this is `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when unset.
On V1, the server supplies the config directory.

```json
{
  "providerID": "vercel",
  "modelID": "zai/glm-5.3-flash",
  "failure": "deny",
  "storeSessions": false
}
```

| field | meaning |
| --- | --- |
| `providerID` | provider that serves the judge model |
| `modelID` | model that judges the commands |
| `failure` | behavior when the judge errors: `deny` (default), `allow`, or `ask` |
| `prompt` | optional replacement judge policy; omitted or blank uses the built-in policy |
| `storeSessions` | write judge conversations to server audit files; `false` by default |

The configured prompt works on both V1 and V2 after the service restarts. Empty
prompts are rejected by the settings dialog. Command text is supplied separately;
do not add a command placeholder to the prompt.

With `"failure": "ask"`, OpenCode V2 requests user approval when the judge fails,
even if configured permissions would allow the command. Explicit configured denials
remain final. **This approval behavior works only in OpenCode V2 (`opencode2`).**
On V1, `ask` still defers to configured permissions and does not force a prompt;
see [Known limitation](#known-limitation).

Environment overrides:

- `SHIELD_BASH_MODEL="provider/model"` overrides the configured judge model. Only the first
  slash splits provider from model, so model IDs that contain a slash (like
  `zai/glm-5.3-flash`) work as-is.
- `SHIELD_BASH_TTL_HOURS` sets the verdict cache TTL in hours (default 24).
- `SHIELD_BASH_STORE_SESSIONS=true` enables judge conversation storage; `false`
  disables it. `1` and `0` are also accepted. This overrides `storeSessions` in
  the config file. An unset or empty variable uses the file setting. Invalid
  values stop command checks with a configuration error.

Missing config falls back to `vercel/zai/glm-5.3-flash`.

### Judge conversation storage

In **Configure Shield Bash**, set **Store judge conversations** to **On** or **Off**,
then select **Save** and restart the service. The dialog shows the server's storage
path and any environment override. You can also set `"storeSessions": true` in
`shield-bash.json`. The server's environment takes precedence, not the TUI machine's.

When enabled, each actual judge request creates one JSON file under
`$XDG_DATA_HOME/shield-bash/sessions/<session-hash>/`, or
`~/.local/share/shield-bash/sessions/<session-hash>/` when `XDG_DATA_HOME` is unset.
Each file records the timestamp, calling session ID, command, policy, model,
raw response, parsed verdict, and any judge or verdict-parsing error. Unique files
keep concurrent judgments separate. Session IDs are hashed only for directory
names; the original ID remains in each record.

**These files can contain secrets from commands, policies, or model responses.**
New directories use mode `0700` and files use `0600` on POSIX systems. Records have
no automatic expiry. Turning storage off stops new records; it does not delete old
files. Cache hits do not create records because no judge conversation takes place.
If storage is enabled but a record cannot be written, the command is blocked even
when `failure` is `allow` or `ask`.

This setting works on V1 and V2 and controls only these audit files. It does not
disable the verdict cache or V1's child judge sessions, which V1 needs to run the
judge. V2 remains stateless apart from the cache and optional audit files.

## What gets denied

The default policy lives in `POLICY_PROMPT` in `src/lib.ts`. The judge must return one JSON
object: allow, or deny with a category (`DG1` through `DG8`), a one-line reason, and
optionally a safer alternative. Categories, in short:

- DG1 destructive unlink (rm/find -delete/shred scoped to a home, bare root, or indiscriminate)
- DG2 disk and device writes (mkfs, dd to device nodes)
- DG3 piping remote output into an interpreter
- DG4 privilege elevation or security erosion (sudo, /etc rewrites, history shredding)
- DG5 shells and listeners (nc -e, bash -i to /dev/tcp, socat EXEC)
- DG6 secret exfiltration to a remote endpoint
- DG7 resource bombs (fork bombs, unbounded recursion)
- DG8 system-wide installs (OS package managers, npm -g, bare pip; project-scoped installs are fine)

Whole pipelines are judged, so one bad segment denies the chain.

## Caching

Verdicts are cached in `~/.cache/shield-bash/verdicts-<prompt-hash>.json` (respecting
`XDG_CACHE_HOME`), keyed by command string, expiring after the TTL, capped at 1000
entries per file. A cache hit skips the judge entirely.
Every prompt, including the built-in policy, has a separate cache file. Changes to
either a custom prompt or the built-in policy cannot reuse decisions from a
different policy. Restoring a previous prompt can reuse its unexpired verdicts.
Legacy `verdicts.json` files are ignored because they do not identify their policy.

## Known limitation

**The forced-approval limitation applies only to OpenCode V1.** V2 uses its
permission-evaluation hook to request approval for `"failure": "ask"`. The request
includes the judge failure reason and applies only to the affected tool call.
An approval is not stored in the plugin's verdict cache.

V1's `permission.ask` hook is declared in `@opencode-ai/plugin` types but never
triggered by the server ([anomalyco/opencode#7006](https://github.com/anomalyco/opencode/issues/7006)).
`tool.execute.before` can only throw (deny) or return (defer to config), so binary
allow/deny plus config-deferred `ask` remains the V1 behavior.
The default policy and DG categories are the same on both versions: the judge returns
only allow/deny. `ask` is a failure setting, not a judge verdict, and does not turn a
judge's denial into an approval request.

## Development

```sh
bun install
bun run typecheck
bun test src/                  # unit: verdict parsing, cache, prompt shape
bun run test:integration       # fixtures through a live judge; skips if no server
```

The integration suite targets V1. It drives the commands in `test/fixtures.json` through a running
`opencode serve` (default `http://localhost:4096`). Start one with:

```sh
opencode serve --port 4096 --hostname 127.0.0.1
```

It needs a provider API key and a reachable server; otherwise it skips. Each fixture gets a
fresh judge session (a reused one recycles earlier reasoning into later verdicts), tests run
serially, and each gets one retry to absorb provider flakiness.

Test-time env vars:

- `SHIELD_BASH_TEST_OPENCODE_URL` — server URL (default `http://localhost:4096`)
- `SHIELD_BASH_TEST_CONFIG` — path to a `shield-bash.json` for the judge model (default:
  `test/shield-bash.json`, which pins the fallback model)
- `SHIELD_BASH_MODEL` — overrides both, with the same provider/model split as the plugin

## Releases

Trunk-based: work merges to `main` and semantic-release runs in CI on every push to `main`.
Conventional commits drive the bumps (`feat` minor, `fix` patch, breaking changes major); each
release publishes to npm, updates `package.json` and `CHANGELOG.md`, and creates a GitHub release.
Never push a `v*` tag by hand, and never publish from a local machine.

## License

MIT
