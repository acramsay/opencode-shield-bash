import type { Database } from "bun:sqlite"
import type { Plugin } from "@opencode/plugin"
import {
  deleteSessionVerdicts,
  getCachedVerdict,
  openCache,
  parseVerdictText,
  setCachedVerdict,
  type ShieldBashConfig,
  type Verdict,
} from "./lib"

export type Judge = {
  isJudgeSession(sessionID: string): boolean
  decide(sessionID: string, command: string): Promise<Verdict>
  deleteSession(sessionID: string): void
  close(): void
}

type ContextMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

const JUDGE_TITLE = "Shield Bash"
const JUDGE_INSTRUCTIONS = "Return the JSON verdict."

export function createJudge(ctx: Plugin.Context, config: ShieldBashConfig): Judge {
  const cache: Database = openCache(config.cachePath)

  // Every root session gets its own judge child; sessions with a parent
  // (subagents) share their root's judge. Both maps memoize in-flight
  // promises so parallel tool calls resolve to exactly one judge per root.
  // Entries are per-process and tiny, so they are left uncapped.
  const judgeByRoot = new Map<string, Promise<string>>()
  const rootBySession = new Map<string, Promise<string>>()
  // The gate waits on this judge's verdict, so re-gating the judge's own shell
  // would deadlock. It is denied outright instead, and the context hook keys
  // the policy injection off this set.
  const judgeSessions = new Set<string>()
  // Prompts must go one at a time: the server queues concurrent prompts on one
  // session and hands every caller the same final message, which would unpair
  // a verdict from its command.
  const promptChain = new Map<string, Promise<unknown>>()

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
        let info: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
        try {
          info = await ctx.session.get({ sessionID: current })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          throw new Error(`failed to resolve session ${sessionID}: ${reason}`)
        }
        const parent = info.parentID
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

  const ensureJudgeSession = (rootID: string): Promise<string> => {
    const pending = judgeByRoot.get(rootID)
    if (pending) return pending
    const created = (async () => {
      // A child of the root, so the TUI's child-session nav reaches it and it
      // stays out of the session list and tied to the root's lifecycle. The
      // deny-all permission set strips every tool from the request; the context
      // hook reinforces this and installs the policy prompt.
      const info = await ctx.session.create({
        parentID: rootID,
        title: JUDGE_TITLE,
        model: { providerID: config.providerID, id: config.modelID },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      })
      judgeSessions.add(info.id)
      return info.id
    })().catch((err) => {
      judgeByRoot.delete(rootID) // a later call may retry creation
      throw err
    })
    judgeByRoot.set(rootID, created)
    return created
  }

  const extractVerdict = (messages: ReadonlyArray<ContextMessage>): Verdict => {
    // Serialized prompts mean the last assistant message is this command's.
    const last = [...messages].reverse().find((message) => message.type === "assistant")
    const content = last && "content" in last ? last.content : undefined
    const text = (content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n")
    if (text === "") throw new Error("judge returned no text")
    return parseVerdictText(text)
  }

  const promptJudge = (rootID: string, judgeID: string, command: string): Promise<Verdict> => {
    const tail = (promptChain.get(rootID) ?? Promise.resolve()).catch(() => {})
    const run = tail.then(async () => {
      await ctx.session.prompt({
        sessionID: judgeID,
        text: `Command: ${command}\n${JUDGE_INSTRUCTIONS}`,
      })
      // SessionWaitInput carries no timeout, so bound the wait and interrupt
      // the run on expiry rather than leaving it burning tokens.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ctx.session.wait({ sessionID: judgeID }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void ctx.session.interrupt({ sessionID: judgeID }).catch(() => {})
              reject(new Error(`judge timed out after ${config.timeoutMs}ms`))
            }, config.timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      return extractVerdict(await ctx.session.context({ sessionID: judgeID }))
    })
    promptChain.set(rootID, run)
    return run
  }

  const decide = async (sessionID: string, command: string): Promise<Verdict> => {
    const rootID = await rootOf(sessionID)
    const cached = getCachedVerdict(cache, rootID, command, config.cacheTtlMs)
    if (cached) return cached
    const judgeID = await ensureJudgeSession(rootID)
    const verdict = await promptJudge(rootID, judgeID, command)
    setCachedVerdict(cache, rootID, command, verdict)
    return verdict
  }

  const deleteSession = (sessionID: string): void => {
    deleteSessionVerdicts(cache, sessionID)
    rootBySession.delete(sessionID)
    judgeByRoot.delete(sessionID)
    judgeSessions.delete(sessionID)
    promptChain.delete(sessionID)
  }

  return {
    isJudgeSession: (sessionID) => judgeSessions.has(sessionID),
    decide,
    deleteSession,
    close: () => cache.close(),
  }
}
