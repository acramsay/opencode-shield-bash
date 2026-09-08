import { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { SettingsRpc, type Settings, type SettingsSnapshot } from "./settings-rpc"
import { POLICY_PROMPT } from "./lib"
import { editPrompt } from "./editor"

function errorMessage(error: unknown): string {
  // RPC failures are plain objects, not Error instances.
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

export default Plugin.define({
  id: "shield-bash.tui",
  setup(ctx) {
    let open = false
    const layer = (): KeymapLayer => ({
      mode: "global",
      commands: [{
        id: "shield-bash.configure",
        title: "Configure Shield Bash",
        group: "Shield Bash",
        palette: true,
        run: async () => {
          if (open) return
          open = true
          try {
            const rpc = ctx.client.rpc(SettingsRpc)
            const options = { location: ctx.location ?? ctx.data.location.default() }
            ctx.ui.toast.show({ message: "Loading Shield Bash settings…", variant: "info" })
            const snapshot = await rpc.read(null, { ...options, signal: AbortSignal.timeout(15_000) }) as SettingsSnapshot
            const draft = { ...snapshot.settings }
            type Action = "model" | "failure" | "prompt" | "storeSessions" | "resetPrompt" | "save" | "cancel"
            let current: Action = "model"
            const override = snapshot.modelOverride ? " · overridden by SHIELD_BASH_MODEL" : ""
            while (true) {
              const action: Action | undefined = await ctx.ui.dialog.select<Action>({
                title: "Configure Shield Bash",
                current,
                options: [
                  { title: "Judge model", value: "model", description: `${draft.providerID}/${draft.modelID}${override}`, category: "Settings" },
                  { title: "On judge failure", value: "failure", description: draft.failure, category: "Settings" },
                  {
                    title: "Store judge conversations", value: "storeSessions", category: "Settings",
                    description: `${draft.storeSessions ? "On" : "Off"}${snapshot.sessionStorageOverride === null ? "" : ` · env override: ${snapshot.sessionStorageOverride ? "On" : "Off"}`}`,
                  },
                  {
                    title: "Judge prompt", value: "prompt",
                    description: `${draft.prompt === POLICY_PROMPT ? "Default" : "Custom"} safety policy · edit in $EDITOR`,
                    category: "Settings",
                  },
                  { title: "Restore default prompt", value: "resetPrompt", description: "Replace the draft prompt with the built-in safety policy", category: "Settings" },
                  { title: "Save", value: "save", description: `Write ${snapshot.path}; service restart required`, category: "Actions" },
                  { title: "Cancel", value: "cancel", description: "Discard unsaved changes", category: "Actions" },
                ],
              })
              if (!action || action === "cancel") return
              current = action
              if (action === "storeSessions") {
                const value = await ctx.ui.dialog.select<boolean>({
                  title: "Save judge conversations on the server",
                  current: draft.storeSessions,
                  options: [
                    { title: "Off", value: false, description: "Stop new records. Existing files remain." },
                    { title: "On", value: true, description: "Save private audit files. May contain secrets." },
                  ],
                })
                if (value !== undefined) {
                  draft.storeSessions = value
                  await ctx.ui.dialog.alert({
                    title: "Judge conversation storage",
                    message: `Server directory: ${snapshot.sessionStoragePath}\n\nRecords can contain secrets and have no automatic expiry. Turning storage off keeps existing files. Select Save to keep this setting.` +
                      (snapshot.sessionStorageOverride === null ? "" : `\n\nSHIELD_BASH_STORE_SESSIONS overrides this setting to ${snapshot.sessionStorageOverride ? "On" : "Off"}.`),
                  })
                }
                continue
              }
              if (action === "resetPrompt") {
                const confirmed = await ctx.ui.dialog.confirm({
                  title: "Restore default judge prompt?",
                  message: "This replaces your draft prompt. Select Save in the settings menu to keep the change.",
                })
                if (confirmed) draft.prompt = POLICY_PROMPT
                continue
              }
              if (action === "prompt") {
                try {
                  draft.prompt = await editPrompt(draft.prompt, ctx.renderer)
                } catch (error) {
                  await ctx.ui.dialog.alert({ title: "Could not edit judge prompt", message: errorMessage(error) })
                }
                continue
              }
              if (action === "save") {
                try {
                  ctx.ui.toast.show({ message: "Saving Shield Bash settings…", variant: "info" })
                  await rpc.save({ settings: draft, revision: snapshot.revision }, { ...options, signal: AbortSignal.timeout(15_000) })
                } catch (error) {
                  await ctx.ui.dialog.alert({ title: "Could not save Shield Bash settings", message: errorMessage(error) })
                  continue
                }
                await ctx.ui.dialog.alert({
                  title: "Shield Bash settings saved",
                  message: "Restart the connected OpenCode service to apply changes." +
                    (override ? " SHIELD_BASH_MODEL still overrides the saved model." : "") +
                    (snapshot.sessionStorageOverride === null ? "" : " SHIELD_BASH_STORE_SESSIONS still overrides the saved storage setting."),
                })
                return
              }
              if (action === "failure") {
                const failure = await ctx.ui.dialog.select<Settings["failure"]>({
                  title: "When the judge fails (not when it denies a command)",
                  current: draft.failure,
                  options: [
                    { title: "Deny", value: "deny", description: "Block the command. Default and safest." },
                    { title: "Ask", value: "ask", description: "Request user approval. Configured denials remain final." },
                    { title: "Allow", value: "allow", description: "Skip the safety judge and defer to OpenCode permissions." },
                  ],
                })
                if (failure) draft.failure = failure
                continue
              }
              const value = await ctx.ui.dialog.prompt({
                title: "Judge model",
                value: `${draft.providerID}/${draft.modelID}`,
                description: "Use provider/model, for example vercel/zai/glm-5.3-flash. Only the first slash separates the provider from the model ID.",
              })
              if (value === undefined) continue
              const separator = value.indexOf("/")
              const providerID = separator < 0 ? "" : value.slice(0, separator).trim()
              const modelID = separator < 0 ? "" : value.slice(separator + 1).trim()
              if (!providerID || !modelID) {
                await ctx.ui.dialog.alert({ title: "Judge model", message: "Enter both provider and model in provider/model format." })
                continue
              }
              draft.providerID = providerID
              draft.modelID = modelID
            }
          } catch (error) {
            await ctx.ui.dialog.alert({ title: "Could not open Shield Bash settings", message: errorMessage(error) })
          } finally {
            open = false
          }
        },
      }],
    })
    // Register inside the app's keymap provider, not during plugin setup.
    return ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(layer)
        return null
      },
    })
  },
})
