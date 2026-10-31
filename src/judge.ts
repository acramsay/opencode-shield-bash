import type { Plugin } from "@opencode/plugin"
import {
  deleteSessionEvents,
  emptyCounters,
  loadCounters,
  loadDedup,
  openDb,
  parseVerdictText,
  recordEvent,
  setEventResolution,
  type Counters,
  type ShieldBashConfig,
  type Verdict,
} from "./lib"

export type Decision = {
  outcome: "allow" | "deny" | "ask"
  verdict?: Verdict
  errorKind?: string
  rowId: number
  rootID: string
}

export type PendingAsk = {
  toolCallId: string
  rowId: number
  rootID: string
  command: string
  sessionID: string
}

export type Judge = {
  isJudgeSession(sessionID: string): boolean
  decide(sessionID: string, command: string): Promise<Decision>
  trackAsk(toolCallId: string, record: Omit<PendingAsk, "toolCallId">): void
  onPermissionAsked(event: { id: string; source?: { type: "tool"; id: string } }): void
  onPermissionReplied(event: { requestID: string; reply: "once" | "always" | "reject" }): void
  deleteSession(sessionID: string): void
  close(): void
}

type ContextMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

type RootState = {
  counters: Counters
  dedup: Map<string, Verdict>
  hydrated: boolean
}

const JUDGE_TITLE = "Shield Bash"
const JUDGE_INSTRUCTIONS = "Return the JSON verdict."

// Both mark failures we detect ourselves, distinct from an inference error
// reported by the API.
class JudgeTimeoutError extends Error {}
class InvalidVerdictError extends Error {}

export function createJudge(
  ctx: Plugin.Context,
  config: ShieldBashConfig,
  onEvent?: (rootID: string, counters: Counters) => void,
): Judge {
  const db = openDb(config.dbPath)

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
  // Prompts must go one at a time. The server queues concurrent prompts on one
  // session and hands every caller the same final message, which would unpair
  // a verdict from its command.
  const promptChain = new Map<string, Promise<unknown>>()

  // Live per-root state, hydrated from the DB on first touch and kept for the
  // process lifetime (no TTL, no cap).
  const states = new Map<string, RootState>()
  const pendingByToolCall = new Map<string, PendingAsk>()
  const pendingByRequest = new Map<string, PendingAsk>()

  const emit = (rootID: string, state: RootState): void => {
    onEvent?.(rootID, state.counters)
  }

  const getState = (rootID: string): RootState => {
    let state = states.get(rootID)
    if (!state) {
      state = { counters: emptyCounters(), dedup: new Map(), hydrated: false }
      states.set(rootID, state)
    }
    if (!state.hydrated) {
      state.counters = loadCounters(db, rootID)
      state.dedup = loadDedup(db, rootID)
      state.hydrated = true
    }
    return state
  }

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
      // SessionWaitInput carries no timeout, so bound the wait and interrupt the
      // run on expiry.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ctx.session.wait({ sessionID: judgeID }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void ctx.session.interrupt({ sessionID: judgeID }).catch(() => {})
              reject(new JudgeTimeoutError(`judge timed out after ${config.timeoutMs}ms`))
            }, config.timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      try {
        return extractVerdict(await ctx.session.context({ sessionID: judgeID }))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new InvalidVerdictError(reason)
      }
    })
    promptChain.set(rootID, run)
    return run
  }

  const countOutcome = (state: RootState, outcome: Decision["outcome"], cached: boolean): void => {
    if (cached) {
      if (outcome === "allow") state.counters.allowCached++
      else if (outcome === "deny") state.counters.denyCached++
      return
    }
    if (outcome === "allow") state.counters.allow++
    else if (outcome === "deny") state.counters.deny++
    else {
      state.counters.ask++
      state.counters.askPending++
    }
  }

  const decide = async (sessionID: string, command: string): Promise<Decision> => {
    const rootID = await rootOf(sessionID)
    const state = getState(rootID)

    const cached = state.dedup.get(command)
    if (cached) {
      const rowId = recordEvent(db, {
        sessionID: rootID,
        command,
        ts: Date.now(),
        outcome: cached.decision,
        cached: 1,
        category: cached.category,
        reason: cached.reason,
        alternative: cached.alternative,
      })
      countOutcome(state, cached.decision, true)
      if (cached.decision === "deny" && cached.category) {
        state.counters.denyByCategory[cached.category] =
          (state.counters.denyByCategory[cached.category] ?? 0) + 1
      }
      emit(rootID, state)
      return { outcome: cached.decision, verdict: cached, rowId, rootID }
    }

    const started = Date.now()
    let verdict: Verdict
    try {
      const judgeID = await ensureJudgeSession(rootID)
      verdict = await promptJudge(rootID, judgeID, command)
    } catch (err) {
      const errorKind =
        err instanceof JudgeTimeoutError
          ? "timeout"
          : err instanceof InvalidVerdictError
            ? "invalid-verdict"
            : "inference"
      const waitMs = Date.now() - started
      const outcome = config.failure
      const rowId = recordEvent(db, {
        sessionID: rootID,
        command,
        ts: Date.now(),
        outcome,
        cached: 0,
        errorKind,
        waitMs,
      })
      countOutcome(state, outcome, false)
      state.counters.errorByKind[errorKind] = (state.counters.errorByKind[errorKind] ?? 0) + 1
      state.counters.waitMs += waitMs
      emit(rootID, state)
      return { outcome, errorKind, rowId, rootID }
    }

    const waitMs = Date.now() - started
    const outcome = verdict.decision
    const rowId = recordEvent(db, {
      sessionID: rootID,
      command,
      ts: Date.now(),
      outcome,
      cached: 0,
      category: verdict.category,
      reason: verdict.reason,
      alternative: verdict.alternative,
      waitMs,
    })
    countOutcome(state, outcome, false)
    if (outcome === "deny" && verdict.category) {
      state.counters.denyByCategory[verdict.category] =
        (state.counters.denyByCategory[verdict.category] ?? 0) + 1
    }
    state.counters.waitMs += waitMs
    // A model ask is not cached. Only a user resolution makes it definitive.
    if (outcome !== "ask") state.dedup.set(command, verdict)
    emit(rootID, state)
    return { outcome, verdict, rowId, rootID }
  }

  const trackAsk = (toolCallId: string, record: Omit<PendingAsk, "toolCallId">): void => {
    pendingByToolCall.set(toolCallId, { toolCallId, ...record })
  }

  const onPermissionAsked: Judge["onPermissionAsked"] = (event) => {
    const callID = event.source?.type === "tool" ? event.source.id : undefined
    if (!callID) return
    const record = pendingByToolCall.get(callID)
    if (record) pendingByRequest.set(event.id, record)
  }

  const onPermissionReplied: Judge["onPermissionReplied"] = (event) => {
    const record = pendingByRequest.get(event.requestID)
    if (!record) return
    pendingByRequest.delete(event.requestID)
    pendingByToolCall.delete(record.toolCallId)

    const state = getState(record.rootID)
    setEventResolution(db, record.rowId, event.reply)
    state.counters.askPending = Math.max(0, state.counters.askPending - 1)
    if (event.reply === "once") {
      state.counters.askOnce++
    } else if (event.reply === "always") {
      state.counters.askAlways++
      state.dedup.set(record.command, { decision: "allow", category: null, reason: "", alternative: null })
    } else {
      state.counters.askReject++
      state.dedup.set(record.command, { decision: "deny", category: null, reason: "", alternative: null })
    }
    emit(record.rootID, state)
  }

  const dropPending = (predicate: (record: PendingAsk) => boolean): void => {
    for (const [toolCallId, record] of pendingByToolCall) {
      if (predicate(record)) pendingByToolCall.delete(toolCallId)
    }
    for (const [requestID, record] of pendingByRequest) {
      if (predicate(record)) pendingByRequest.delete(requestID)
    }
  }

  const deleteSession = (sessionID: string): void => {
    deleteSessionEvents(db, sessionID)
    states.delete(sessionID)
    rootBySession.delete(sessionID)
    judgeByRoot.delete(sessionID)
    judgeSessions.delete(sessionID)
    promptChain.delete(sessionID)
    dropPending((record) => record.sessionID === sessionID || record.rootID === sessionID)
  }

  return {
    isJudgeSession: (sessionID) => judgeSessions.has(sessionID),
    decide,
    trackAsk,
    onPermissionAsked,
    onPermissionReplied,
    deleteSession,
    // The DB handle is shared across per-location setups, so this plugin's
    // cleanup must not close it.
    close: () => {},
  }
}
