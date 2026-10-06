import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { setup } from "./index"
import { POLICY_PROMPT } from "./lib"

type FakeSession = { parentID?: string }

type FakeOptions = {
  options?: Record<string, unknown>
  failFirstCreate?: boolean
  slowPrompt?: boolean
  failPrompt?: boolean
  verdictText?: string
}

// Minimal fake of the v2 plugin context surface the plugin touches.
const makeCtx = (sessions: Record<string, FakeSession>, opts: FakeOptions = {}) => {
  const state = {
    creates: 0,
    createdParents: [] as string[],
    createdPermissions: [] as unknown[],
    prompts: 0,
    promptTexts: [] as string[],
    gets: 0,
    promptActive: 0,
    promptMaxActive: 0,
    waits: 0,
    interrupts: 0,
  }
  const contextHandlers: Array<(event: any) => void> = []
  const permissionHandlers: Array<(event: any) => void> = []
  const beforeHandlers: Array<(event: any) => Promise<void>> = []
  const afterHandlers: Array<(event: any) => void> = []

  const eventBuffer: any[] = []
  let eventNotify: (() => void) | null = null
  const emit = (event: any) => {
    eventBuffer.push(event)
    eventNotify?.()
    eventNotify = null
  }

  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      state.gets++
      const found = sessions[sessionID]
      if (!found) throw new Error("session not found")
      return { id: sessionID, parentID: found.parentID }
    },
    create: async (input: any) => {
      state.creates++
      state.createdParents.push(input.parentID ?? "")
      state.createdPermissions.push(input.permissions)
      await new Promise((r) => setTimeout(r, 5))
      if (opts.failFirstCreate && state.creates === 1) throw new Error("boom")
      return { id: `judge-${state.creates}`, parentID: input.parentID, permissions: input.permissions }
    },
    prompt: async (input: any) => {
      state.prompts++
      state.promptTexts.push(input.text)
      if (opts.failPrompt) throw new Error("prompt boom")
      if (opts.slowPrompt) {
        state.promptActive++
        state.promptMaxActive = Math.max(state.promptMaxActive, state.promptActive)
        await new Promise((r) => setTimeout(r, 5))
        state.promptActive--
      }
      return { type: "user", payload: { text: input.text } }
    },
    wait: async () => {
      state.waits++
    },
    context: async () => [
      { type: "user", content: null },
      { type: "assistant", content: [{ type: "text", text: opts.verdictText ?? '{"decision":"allow"}' }] },
      { type: "idle", content: null },
    ],
    interrupt: async () => {
      state.interrupts++
    },
    hook: async (_name: string, callback: any) => {
      contextHandlers.push(callback)
      return { dispose: async () => {} }
    },
  }
  const permission = {
    hook: async (_name: string, callback: any) => {
      permissionHandlers.push(callback)
      return { dispose: async () => {} }
    },
  }
  const tool = {
    hook: async (name: string, callback: any) => {
      if (name === "execute.before") beforeHandlers.push(callback)
      else afterHandlers.push(callback)
      return { dispose: async () => {} }
    },
  }
  const event = {
    subscribe: ({ signal }: { signal: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (true) {
              if (eventBuffer.length) return { value: eventBuffer.shift()!, done: false as const }
              if (signal.aborted) return { value: undefined, done: true as const }
              await new Promise<void>((resolve) => {
                eventNotify = resolve
              })
            }
          },
          async return() {
            return { value: undefined, done: true as const }
          },
        }
      },
    }),
  }
  const ctx = {
    options: { providerID: "test", modelID: "m", ...(opts.options ?? {}) },
    session,
    permission,
    tool,
    event,
  }
  return { ctx, state, emit, contextHandlers, permissionHandlers, beforeHandlers, afterHandlers }
}

const initPlugin = async (sessions: Record<string, FakeSession>, opts: FakeOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "shield-bash-test-"))
  const made = makeCtx(sessions, { ...opts, options: { cachePath: join(dir, "verdicts.db"), ...(opts.options ?? {}) } })
  await setup(made.ctx as unknown as Plugin.Context)
  return made
}

const gate = (
  before: (event: any) => Promise<void>,
  command: string,
  sessionID: string,
  callID = command,
  tool = "shell",
) => before({ tool, sessionID, agent: "build", messageID: "msg", id: callID, input: { command } })

const tick = () => new Promise((r) => setTimeout(r, 10))

describe("judge session lifecycle", () => {
  test("concurrent shell calls from one root share a single judge child", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await Promise.all([
      gate(beforeHandlers[0], "cmd-a", "root-1"),
      gate(beforeHandlers[0], "cmd-b", "root-1"),
      gate(beforeHandlers[0], "cmd-c", "root-1"),
    ])
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
    expect(state.prompts).toBe(3)
  })

  test("concurrent shell calls prompt the judge one at a time", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} }, { slowPrompt: true })
    await Promise.all([
      gate(beforeHandlers[0], "cmd-a", "root-1"),
      gate(beforeHandlers[0], "cmd-b", "root-1"),
      gate(beforeHandlers[0], "cmd-c", "root-1"),
    ])
    expect(state.prompts).toBe(3)
    expect(state.promptMaxActive).toBe(1)
  })

  test("subagent sessions share their root's judge session", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {}, "sub-1": { parentID: "root-1" } })
    await gate(beforeHandlers[0], "cmd-a", "sub-1")
    await gate(beforeHandlers[0], "cmd-b", "root-1")
    await gate(beforeHandlers[0], "cmd-c", "sub-1")
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
  })

  test("each root session gets its own judge child", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {}, "root-2": {} })
    await Promise.all([
      gate(beforeHandlers[0], "cmd-a", "root-1"),
      gate(beforeHandlers[0], "cmd-b", "root-2"),
    ])
    expect(state.creates).toBe(2)
    expect(state.createdParents.sort()).toEqual(["root-1", "root-2"])
  })

  test("nested subagents resolve to the root, and walks are memoized", async () => {
    const { state, beforeHandlers } = await initPlugin({
      "root-1": {},
      "sub-1": { parentID: "root-1" },
      "sub-2": { parentID: "sub-1" },
      "sub-3": { parentID: "root-1" },
    })
    await gate(beforeHandlers[0], "cmd-a", "sub-2") // walks sub-2 -> sub-1 -> root-1
    const getsAfterFirst = state.gets
    await gate(beforeHandlers[0], "cmd-b", "sub-1") // memoized by the first walk
    await gate(beforeHandlers[0], "cmd-c", "sub-3") // only sub-3 is a new hop
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
    expect(state.gets).toBe(getsAfterFirst + 1)
  })

  test("the judge session is created with a deny-all permission set", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    expect(state.createdPermissions[0]).toEqual([{ action: "*", resource: "*", effect: "deny" }])
  })

  test("a cached verdict skips the root lookup, the judge session, and the prompt", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    const counts = { ...state }
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    expect(state).toEqual(counts)
  })

  test("failed judge session creation is retried on the next call", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} }, { failFirstCreate: true })
    await expect(gate(beforeHandlers[0], "cmd-a", "root-1")).rejects.toThrow("judge unavailable")
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    expect(state.creates).toBe(2)
  })

  test("a session whose parent chain cannot be resolved is retried on the next call", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await expect(gate(beforeHandlers[0], "cmd-a", "ghost-1")).rejects.toThrow("failed to resolve session")
    await gate(beforeHandlers[0], "cmd-b", "root-1")
    expect(state.creates).toBe(1)
  })

  test("session.deleted purges only that root's cached verdicts", async () => {
    const { state, beforeHandlers, emit } = await initPlugin({ "root-1": {}, "root-2": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    await gate(beforeHandlers[0], "cmd-a", "root-2")
    expect(state.prompts).toBe(2)

    emit({ type: "session.deleted", data: { sessionID: "root-1" } })
    await tick()

    await gate(beforeHandlers[0], "cmd-a", "root-1") // cache purged: re-judged
    await gate(beforeHandlers[0], "cmd-a", "root-2") // still cached: no new prompt
    expect(state.prompts).toBe(3)
  })

  test("an unrelated event type does not touch the cache", async () => {
    const { state, beforeHandlers, emit } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    emit({ type: "session.updated", data: { sessionID: "root-1" } })
    await tick()
    await gate(beforeHandlers[0], "cmd-a", "root-1")
    expect(state.prompts).toBe(1)
  })
})

describe("judge isolation", () => {
  test("the context hook injects the policy and strips tools for judge sessions only", async () => {
    const { beforeHandlers, contextHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1") // creates judge-1

    const normal = { sessionID: "root-1", tools: { shell: {} }, system: [{ type: "text", text: "agent" }], options: {} as Record<string, unknown> }
    contextHandlers[0](normal)
    expect(normal.system).toEqual([{ type: "text", text: "agent" }])
    expect(Object.keys(normal.tools)).toEqual(["shell"])

    const judge = { sessionID: "judge-1", tools: { shell: {} }, system: [{ type: "text", text: "agent" }], options: {} as Record<string, unknown> }
    contextHandlers[0](judge)
    expect(judge.system).toEqual([{ type: "text", text: POLICY_PROMPT }])
    expect(Object.keys(judge.tools)).toEqual([])
    expect(judge.options.temperature).toBe(0)
  })

  test("judge prompts carry the command and the verdict instruction", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "ls -la", "root-1")
    expect(state.promptTexts[0]).toBe("Command: ls -la\nReturn the JSON verdict.")
  })

  test("a judge session cannot re-enter the gate", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "cmd-a", "root-1") // creates judge-1
    const before = { ...state }
    await expect(gate(beforeHandlers[0], "cmd-x", "judge-1")).rejects.toThrow("judge cannot run commands")
    expect(state.creates).toBe(before.creates)
    expect(state.prompts).toBe(before.prompts)
    expect(state.gets).toBe(before.gets)
  })
})

describe("tool gating", () => {
  test("the AFT bash tool is gated like the host shell tool", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "ls", "root-1", "call-1", "bash")
    expect(state.prompts).toBe(1)
  })

  test("an unrelated tool name is not gated", async () => {
    const { state, beforeHandlers } = await initPlugin({ "root-1": {} })
    await expect(gate(beforeHandlers[0], "ls", "root-1", "call-1", "read")).resolves.toBeUndefined()
    expect(state.prompts).toBe(0)
  })
})

describe("verdict handling", () => {
  test("an allow verdict lets the command through", async () => {
    const { beforeHandlers } = await initPlugin({ "root-1": {} })
    await expect(gate(beforeHandlers[0], "ls", "root-1")).resolves.toBeUndefined()
  })

  test("a deny verdict throws with the category and reason", async () => {
    const { beforeHandlers } = await initPlugin(
      { "root-1": {} },
      { verdictText: '{"decision":"deny","category":"DG1","reason":"rm -rf /","alternative":"rm ./x"}' },
    )
    await expect(gate(beforeHandlers[0], "rm -rf /", "root-1")).rejects.toThrow(/DG1[\s\S]*rm -rf \/[\s\S]*rm \.\/x/)
  })
})

describe("failure modes", () => {
  test("deny (default) fails closed when the judge is unavailable", async () => {
    const { beforeHandlers } = await initPlugin({ "root-1": {} }, { failPrompt: true })
    await expect(gate(beforeHandlers[0], "ls", "root-1")).rejects.toThrow("judge unavailable")
  })

  test("allow passes the command through when the judge is unavailable", async () => {
    const { beforeHandlers } = await initPlugin({ "root-1": {} }, { failPrompt: true, options: { failure: "allow" } })
    await expect(gate(beforeHandlers[0], "ls", "root-1")).resolves.toBeUndefined()
  })

  test("ask flags the call and the permission hook upgrades it to a real ask", async () => {
    const { beforeHandlers, permissionHandlers } = await initPlugin(
      { "root-1": {} },
      { failPrompt: true, options: { failure: "ask" } },
    )
    await expect(gate(beforeHandlers[0], "ls", "root-1", "call-1")).resolves.toBeUndefined()

    const evaluation = { source: { type: "tool", id: "call-1" }, effect: "allow", message: undefined as string | undefined }
    permissionHandlers[0](evaluation)
    expect(evaluation.effect).toBe("ask")
    expect(evaluation.message).toContain("shield-bash")
  })

  test("the permission hook leaves unrelated calls untouched", async () => {
    const { beforeHandlers, permissionHandlers } = await initPlugin({ "root-1": {} })
    await gate(beforeHandlers[0], "ls", "root-1", "call-1")
    const evaluation = { source: { type: "tool", id: "other-call" }, effect: "allow", message: undefined as string | undefined }
    permissionHandlers[0](evaluation)
    expect(evaluation.effect).toBe("allow")
    expect(evaluation.message).toBeUndefined()
  })
})
