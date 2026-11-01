// Temporary workaround for anomalyco/opencode#39986: the packaged CLI does not
// run the OpenTUI Solid JSX transform on TSX loaded from node_modules, so the
// published TUI entry must be precompiled JS. Probe the host runtime registry,
// then load the compiled bundle; fall back to raw TSX for local/dev hosts.
let mod
try {
  await import("opentui:runtime-module:" + encodeURIComponent("@opentui/solid"))
  mod = await import("./tui.compiled.tsx")
} catch {
  mod = await import("./tui.tsx")
}

export default mod.default
