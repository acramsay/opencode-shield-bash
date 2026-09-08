import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { defaultConfig, parseVerdictText, readCache, saveCache } from "./lib"

type Model = { providerID: string; modelID: string }
type FailureMode = "allow" | "deny" | "ask"

export async function createGate(runtime: {
  configDirectory: () => Promise<string | undefined>
  judge: (command: string, sessionID: string, model: Model) => Promise<string>
}) {
  const config = defaultConfig()
  mkdirSync(dirname(config.cachePath), { recursive: true })
  const cache = await readCache(config.cachePath, config.cacheTtlMs)
  let model: Model = { providerID: "vercel", modelID: "zai/glm-5.3-flash" }
  let failureMode: FailureMode = "deny"
  let configLoaded: Promise<void> | null = null

  // V1 cannot serve client requests until plugin initialization returns.
  const loadConfig = () => {
    if (configLoaded) return configLoaded
    configLoaded = (async () => {
      try {
        const directory = await runtime.configDirectory()
        if (directory) {
          const json = await Bun.file(join(directory, "shield-bash.json")).json()
          if (
            typeof json.providerID === "string" && json.providerID &&
            typeof json.modelID === "string" && json.modelID
          ) {
            model = { providerID: json.providerID, modelID: json.modelID }
          }
          if (json.failure === "allow" || json.failure === "deny" || json.failure === "ask") {
            failureMode = json.failure
          }
        }
      } catch {}
      // Only the first slash separates the provider from the model ID.
      const override = process.env.SHIELD_BASH_MODEL?.split("/")
      const modelID = override?.slice(1).join("/")
      if (override?.[0] && modelID) model = { providerID: override[0], modelID }
    })()
    return configLoaded
  }

  return async (command: unknown, sessionID: string) => {
    if (typeof command !== "string" || command.trim() === "") return
    await loadConfig()
    const cached = cache.get(command)
    let verdict
    try {
      verdict = cached?.verdict ?? parseVerdictText(await runtime.judge(command, sessionID, model))
    } catch (err) {
      if (failureMode === "allow") return
      const reason = err instanceof Error ? err.message : String(err)
      if (failureMode === "ask") {
        return { message: `shield-bash judge unavailable. Approve this command?\nDetail: ${reason}` }
      }
      throw new Error(`shield-bash denied (judge unavailable, fail-closed).\nDetail: ${reason}`)
    }

    if (!cached) {
      cache.set(command, { verdict, ts: Date.now() })
      await saveCache(config.cachePath, cache)
    }
    if (verdict.decision === "deny") {
      const category = verdict.category ? `\nCategory: ${verdict.category}` : ""
      const alt = verdict.alternative ? `\nAlternative: ${verdict.alternative}` : ""
      throw new Error(`shield-bash denied.${category}\nReason: ${verdict.reason}${alt}`)
    }
  }
}
