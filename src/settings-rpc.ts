import { Rpc } from "@opencode/plugin/rpc"

export type Settings = {
  providerID: string
  modelID: string
  failure: "deny" | "allow" | "ask"
  prompt: string
  storeSessions: boolean
}

export type SettingsSnapshot = {
  settings: Settings
  path: string
  modelOverride: string
  sessionStorageOverride: boolean | null
  sessionStoragePath: string
  revision: string | null
}

export const settingsSchema = {
  type: "object",
  properties: {
    providerID: { type: "string", minLength: 1 },
    modelID: { type: "string", minLength: 1 },
    failure: { type: "string", enum: ["deny", "allow", "ask"] },
    prompt: { type: "string", minLength: 1 },
    storeSessions: { type: "boolean" },
  },
  required: ["providerID", "modelID", "failure", "prompt", "storeSessions"],
  additionalProperties: false,
} as const

export const SettingsRpc = Rpc.define({
  id: "shield-bash.settings",
  events: {},
  methods: {
    read: {
      errors: { failed: { type: "null" } },
      input: { type: "null" },
      output: {
        type: "object",
        properties: {
          settings: settingsSchema,
          path: { type: "string" },
          modelOverride: { type: "string" },
          sessionStorageOverride: { type: ["boolean", "null"] },
          sessionStoragePath: { type: "string" },
          revision: { type: ["string", "null"] },
        },
        required: ["settings", "path", "modelOverride", "sessionStorageOverride", "sessionStoragePath", "revision"],
        additionalProperties: false,
      },
    },
    save: {
      errors: { failed: { type: "null" } },
      output: { type: "null" },
      input: {
        type: "object",
        properties: { settings: settingsSchema, revision: { type: ["string", "null"] } },
        required: ["settings", "revision"],
        additionalProperties: false,
      },
    },
  },
})
