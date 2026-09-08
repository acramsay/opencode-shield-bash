import type { Plugin } from "@opencode-ai/plugin"
import { createGate } from "./gate"

// Gates every bash command by prompting a second opencode session with the
// configured safety policy.
export const ShieldBash: Plugin = async ({ client, directory }) => {
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

  const gate = await createGate({
    configDirectory: async () => (await client.path.get({ query: { directory } })).data?.config,
    judge: async (command, sessionID, model, prompt) => {
      const sessID = await ensureJudgeSession(await rootOf(sessionID))
      const response = await client.session.prompt({
        path: { id: sessID },
        body: {
          system: prompt,
          parts: [{ type: "text", text: `Command: ${command}\nReturn the JSON verdict.` }] as const,
          model,
        } as never,
        query: { directory },
      })
      if (response.error || !response.data) {
        throw new Error(`judge session error: ${JSON.stringify(response.error)}`)
      }
      const textPart = response.data.parts.find((p) => p.type === "text")
      if (!textPart || textPart.type !== "text") throw new Error("judge returned no text")
      return textPart.text
    },
  })

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      await gate(output.args.command, input.sessionID)
    },
  }
}
