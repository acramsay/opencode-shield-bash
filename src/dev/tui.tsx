import { Plugin } from "@opencode/plugin/tui"
import tui from "../tui"

// Development entrypoint. The published package registers as `shield-bash-tui`;
// a source checkout registers as `shield-bash-tui-dev` so it can load alongside
// the published TUI part without an ID collision.
const dev: Plugin.Definition = { ...tui, id: "shield-bash-tui-dev" }

export default dev
