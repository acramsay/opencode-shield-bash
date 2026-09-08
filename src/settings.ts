import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Settings, SettingsSnapshot } from "./settings-rpc"
import { POLICY_PROMPT } from "./lib"
import { retentionDays, sessionRetentionOverride, sessionStorageDirectory, sessionStorageOverride } from "./audit"

async function readDocument(path: string) {
  let revision: string | null
  try {
    revision = await readFile(path, "utf8")
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    revision = null
  }
  const document = revision === null ? {} : JSON.parse(revision)
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("shield-bash.json must contain a JSON object.")
  }
  return { document, revision }
}

export async function readSettings(path: string): Promise<SettingsSnapshot> {
  const { document, revision } = await readDocument(path)
  const providerID = typeof document.providerID === "string" ? document.providerID.trim() : ""
  const modelID = typeof document.modelID === "string" ? document.modelID.trim() : ""
  const override = process.env.SHIELD_BASH_MODEL ?? ""
  const separator = override.indexOf("/")
  return {
    settings: {
      providerID: providerID && modelID ? providerID : "vercel",
      modelID: providerID && modelID ? modelID : "zai/glm-5.3-flash",
      failure: document.failure === "allow" || document.failure === "ask" ? document.failure : "deny",
      prompt: typeof document.prompt === "string" && document.prompt.trim() ? document.prompt : POLICY_PROMPT,
      storeSessions: document.storeSessions === true,
      sessionRetentionDays: retentionDays(document.sessionRetentionDays),
    },
    path,
    modelOverride: separator > 0 && separator < override.length - 1 ? override : "",
    sessionStorageOverride: sessionStorageOverride() ?? null,
    sessionStoragePath: sessionStorageDirectory(),
    sessionRetentionOverride: sessionRetentionOverride() ?? null,
    revision,
  }
}

// Different locations and TUI clients can edit the same global file.
const saving = new Set<string>()

export async function saveSettings(path: string, settings: Settings, revision: string | null) {
  settings = { ...settings, providerID: settings.providerID.trim(), modelID: settings.modelID.trim() }
  if (!settings.providerID || !settings.modelID) throw new Error("Provider ID and Model ID cannot be empty.")
  if (!settings.prompt.trim()) throw new Error("Judge prompt cannot be empty. Use Restore default prompt instead.")
  retentionDays(settings.sessionRetentionDays)
  if (saving.has(path)) throw new Error("Shield Bash settings are being saved. Try again.")
  saving.add(path)
  try {
    await writeSettings(path, settings, revision)
  } finally {
    saving.delete(path)
  }
}

async function writeSettings(path: string, settings: Settings, revision: string | null) {
  const current = await readDocument(path)
  if (current.revision !== revision) {
    throw new Error("Settings changed while this dialog was open. Cancel and reopen it before saving.")
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const document = { ...current.document, ...settings }
  // Omission follows future built-in policy updates; only custom text is pinned.
  if (settings.prompt === POLICY_PROMPT) delete document.prompt
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
