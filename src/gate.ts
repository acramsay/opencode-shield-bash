import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { defaultConfig, parseVerdictText, POLICY_PROMPT, readCache, saveCache, type CacheEntry } from "./lib"
import { retentionDays, sessionRetentionOverride, sessionStorageOverride, storeJudgeConversation } from "./audit"
import type { CheckStatus } from "./status"

type Model = { providerID: string; modelID: string }
type FailureMode = "allow" | "deny" | "ask"

export async function createGate(runtime: {
  configDirectory: () => Promise<string | undefined>
  judge: (command: string, sessionID: string, model: Model, prompt: string) => Promise<string>
  policySuffix?: string
}) {
  const config = defaultConfig()
  mkdirSync(dirname(config.cachePath), { recursive: true })
  let cache = new Map<string, CacheEntry>()
  let prompt = POLICY_PROMPT
  let model: Model = { providerID: "vercel", modelID: "zai/glm-5.3-flash" }
  let failureMode: FailureMode = "deny"
  let storeSessions = false
  let configuredRetention: unknown
  let sessionRetentionDays = 7
  let configLoaded: Promise<void> | null = null

  // V1 cannot serve client requests until plugin initialization returns.
  const loadConfig = () => {
    if (configLoaded) return configLoaded
    configLoaded = (async () => {
      try {
        const directory = await runtime.configDirectory()
        if (directory) {
          const json = await Bun.file(join(directory, "shield-bash.json")).json()
          if (typeof json.prompt === "string" && json.prompt.trim()) prompt = json.prompt
          if (typeof json.storeSessions === "boolean") storeSessions = json.storeSessions
          configuredRetention = json.sessionRetentionDays
          if (
            typeof json.providerID === "string" && json.providerID.trim() &&
            typeof json.modelID === "string" && json.modelID.trim()
          ) {
            model = { providerID: json.providerID.trim(), modelID: json.modelID.trim() }
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
      storeSessions = sessionStorageOverride() ?? storeSessions
      sessionRetentionDays = retentionDays(configuredRetention)
      sessionRetentionDays = sessionRetentionOverride() ?? sessionRetentionDays
      if (runtime.policySuffix) prompt = `${prompt}\n\n${runtime.policySuffix}`
      // A changed policy must never reuse verdicts from a different prompt.
      const hash = createHash("sha256").update(prompt).digest("hex")
      config.cachePath = join(dirname(config.cachePath), `verdicts-${hash}.json`)
      cache = await readCache(config.cachePath, config.cacheTtlMs)
    })()
    return configLoaded
  }

  const evaluate = async (command: unknown, sessionID: string, report: (status: CheckStatus) => void) => {
    if (typeof command !== "string" || command.trim() === "") return
    await loadConfig()
    const cached = cache.get(command)
    let verdict = cached?.verdict
    let failure: string | null = null
    if (!verdict) {
      let response: string | null = null
      try {
        response = await runtime.judge(command, sessionID, model, prompt)
        verdict = parseVerdictText(response)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      // Audit failures stay outside judge failure handling: failure=allow must
      // never turn a denied verdict or a missing required record into execution.
      if (storeSessions) {
        await storeJudgeConversation({ sessionID, command, policy: prompt, model, response, verdict: verdict ?? null, error: failure }, sessionRetentionDays)
      }
    }
    if (!verdict) {
      const reason = failure ?? "Judge returned no verdict."
      report({ state: failureMode === "ask" ? "approval" : "error", reason: "Safety judge unavailable", detail: reason, cached: false, outcome: failureMode })
      if (failureMode === "allow") return
      if (failureMode === "ask") {
        return { message: `shield-bash judge unavailable. Approve this action?\nDetail: ${reason}` }
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
      report({ state: "blocked", reason: verdict.reason, detail: `${verdict.reason}${category}${alt}`, cached: !!cached, outcome: "deny" })
      throw new Error(`shield-bash denied.${category}\nReason: ${verdict.reason}${alt}`)
    }
    report({ state: "allowed", reason: "", detail: "", cached: !!cached, outcome: "allow" })
  }

  return async (command: unknown, sessionID: string, onStatus?: (status: CheckStatus) => void) => {
    if (typeof command !== "string" || command.trim() === "") return
    let reported = false
    const report = (status: CheckStatus) => {
      reported = status.state !== "checking"
      // Display failures must never change a safety decision.
      try { onStatus?.(status) } catch {}
    }
    report({ state: "checking", reason: "", detail: "", cached: false, outcome: "pending" })
    try {
      return await evaluate(command, sessionID, report)
    } catch (error) {
      if (!reported) report({ state: "error", reason: "Safety check failed", detail: error instanceof Error ? error.message : String(error), cached: false, outcome: "deny" })
      throw error
    }
  }
}
