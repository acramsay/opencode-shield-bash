import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  defaultConfig,
  deleteSessionVerdicts,
  getCachedVerdict,
  openCache,
  parseVerdictText,
  POLICY_PROMPT,
  setCachedVerdict,
} from "./lib"

type FailureMode = "allow" | "deny" | "ask"

const DEFAULT_FAILURE: FailureMode = "deny"
const MODEL_FALLBACK = { providerID: "vercel", modelID: "zai/glm-5.3-flash" }

// Gates every bash command by prompting a second opencode session with the
// policy in lib.ts.
export const ShieldBash: Plugin = async ({ client, directory }) => {
  const config = defaultConfig()
  mkdirSync(dirname(config.cachePath), { recursive: true })
  const cache = openCache(config.cachePath)

  // Loaded lazily. The server serves no requests until plugin init returns,
  // so a client call at init time would deadlock.
  let model = MODEL_FALLBACK
  let failureMode: FailureMode = DEFAULT_FAILURE
  let configLoaded: Promise<void> | null = null
  const loadConfig = () => {
    if (configLoaded) return configLoaded
    configLoaded = (async () => {
      try {
        const path = await client.path.get({ query: { directory } })
        if (path.data?.config) {
          const file = join(path.data.config, "shield-bash.json")
          const json = (await Bun.file(file).json()) as {
            providerID?: string
            modelID?: string
            failure?: string
          }
          if (json.providerID && json.modelID) model = json as typeof model
          if (json.failure === "allow" || json.failure === "deny" || json.failure === "ask") {
            failureMode = json.failure
          }
        }
      } catch {}
      // "provider/model" — the modelID itself may contain a slash
      // (e.g. "vercel/zai/glm-5.3-flash"), so only the first segment is the provider.
      const envOverride = process.env.SHIELD_BASH_MODEL?.split("/")
      if (envOverride?.length && envOverride[0]) {
        const modelID = envOverride.slice(1).join("/")
        if (modelID) model = { providerID: envOverride[0], modelID }
      }
    })()
    return configLoaded
  }

  // Every root session gets its own judge child; sessions with a parent
  // (subagents) share their root's judge. Both maps memoize in-flight
  // promises so parallel tool calls resolve to exactly one judge per root.
  // Entries are per-process and tiny, so they are left uncapped.
  const judgeByRoot = new Map<string, Promise<string>>()
  const rootBySession = new Map<string, Promise<string>>()

  // Walks the session's parent chain to its root, memoizing every hop.
  const rootOf = (sessionID: string): Promise<string> => {
    const memo = rootBySession.get(sessionID)
    if (memo) return memo
    const walked = (async () => {
      const chain = [sessionID]
      const seen = new Set(chain)
      let current = sessionID
      while (true) {
        // An ancestor may already be resolved by an earlier walk; reuse it
        // instead of re-fetching the rest of its chain.
        const memo = rootBySession.get(current)
        if (memo) return { root: await memo, chain }
        const res = await client.session.get({ path: { id: current } })
        if (res.error || !res.data) {
          throw new Error(`failed to resolve session ${sessionID}: ${JSON.stringify(res.error)}`)
        }
        const parent = res.data.parentID
        if (!parent || seen.has(parent)) break // no parent, or a cycle that can't reach a root
        seen.add(parent)
        chain.push(parent)
        current = parent
      }
      return { root: current, chain }
    })()
    const promise = walked.then(({ root }) => root)
    rootBySession.set(sessionID, promise)
    // A failed lookup must not poison the session; it is dropped so a later
    // call walks again.
    walked
      .then(({ chain }) => {
        for (const id of chain) if (!rootBySession.has(id)) rootBySession.set(id, promise)
      })
      .catch(() => {
        if (rootBySession.get(sessionID) === promise) rootBySession.delete(sessionID)
      })
    return promise
  }

  const ensureJudgeSession = (rootSessionID: string): Promise<string> => {
    const pending = judgeByRoot.get(rootSessionID)
    if (pending) return pending
    const created = client.session
      .create({
        // A child of the root, so the TUI's child-session nav reaches it and
        // it stays out of the session list and tied to the root's lifecycle.
        body: { parentID: rootSessionID, title: "Shield Bash" },
        query: { directory },
      })
      .then((judgeSession) => {
        if (judgeSession.error || !judgeSession.data) {
          throw new Error(`failed to create judge session: ${JSON.stringify(judgeSession.error)}`)
        }
        return judgeSession.data.id
      })
      .catch((err) => {
        judgeByRoot.delete(rootSessionID) // a later call may retry creation
        throw err
      })
    judgeByRoot.set(rootSessionID, created)
    return created
  }

  // The server joins concurrent prompts to one session into a single run
  // and hands every caller the same final message, so prompts must go one
  // at a time to keep each verdict paired to its command.
  const promptChain = new Map<string, Promise<unknown>>()
  const promptJudge = (judgeSessionID: string, command: string) => {
    const tail = (promptChain.get(judgeSessionID) ?? Promise.resolve()).catch(() => {})
    const run = tail.then(() =>
      client.session.prompt({
        path: { id: judgeSessionID },
        body: {
          system: POLICY_PROMPT,
          parts: [{ type: "text", text: `Command: ${command}\nReturn the JSON verdict.` }] as const,
          model,
        } as never,
        query: { directory },
      }),
    )
    promptChain.set(judgeSessionID, run)
    return run
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      deleteSessionVerdicts(cache, event.properties.info.id)
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output.args.command
      if (typeof command !== "string" || command.trim() === "") return
      await loadConfig()

      let rootID: string
      let cached: ReturnType<typeof getCachedVerdict>
      let verdict
      try {
        rootID = await rootOf(input.sessionID)
        cached = getCachedVerdict(cache, rootID, command, config.cacheTtlMs)
        if (cached) {
          verdict = cached
        } else {
          const sessID = await ensureJudgeSession(rootID)
          const response = await promptJudge(sessID, command)
          if (response.error || !response.data) {
            throw new Error(`judge session error: ${JSON.stringify(response.error)}`)
          }
          const textParts = response.data.parts.filter((p) => p.type === "text") as Array<{
            type: "text"
            text: string
          }>
          const text = textParts.map((p) => p.text).join("\n")
          if (text === "") throw new Error("judge returned no text")
          verdict = parseVerdictText(text)
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (failureMode === "allow") return
        // The permission.ask hook never fires upstream, so ask defers to config.
        if (failureMode === "ask") return
        throw new Error(
          `shield-bash denied (judge unavailable, fail-closed).\nDetail: ${reason}`,
        )
      }

      if (!cached) setCachedVerdict(cache, rootID, command, verdict)
      if (verdict.decision === "deny") {
        const category = verdict.category ? `\nCategory: ${verdict.category}` : ""
        const alt = verdict.alternative ? `\nAlternative: ${verdict.alternative}` : ""
        throw new Error(
          `shield-bash (session-based safety gate for unattended bash) denied.${category}\nReason: ${verdict.reason}${alt}`,
        )
      }
    },
  }
}
