import type { Plugin } from "@opencode/plugin"
import plugin from "../index"

// Development entrypoint. The published package registers as `shield-bash`; a
// source checkout registers as `shield-bash-dev` so it can be configured
// alongside the published plugin without a duplicate-plugin-ID collision.
const dev: Plugin.Plugin = { ...plugin, id: "shield-bash-dev" }

export default dev
