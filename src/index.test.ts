import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ShieldBash } from "./index"

type FakeSession = { parentID?: string }

// Minimal fake of the SDK client surface the plugin touches.
const makeClient = (sessions: Record<string, FakeSession>, opts?: { failFirstCreate?: boolean }) => {
  const state = { creates: 0, createdParents: [] as string[], prompts: 0, gets: 0 }
  const client = {
    path: {
      get: async () => ({ data: {} }),
    },
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        state.gets++
        const session = sessions[path.id]
        if (!session) return { error: { message: "not found" } }
        return { data: { id: path.id, parentID: session.parentID } }
      },
      create: async (args: { body: { parentID?: string } }) => {
        state.creates++
        state.createdParents.push(args.body.parentID ?? "")
        await new Promise((r) => setTimeout(r, 5))
        if (opts?.failFirstCreate && state.creates === 1) return { error: { message: "boom" } }
        return { data: { id: `judge-${state.creates}` } }
      },
      prompt: async () => {
        state.prompts++
        return { data: { parts: [{ type: "text", text: '{"decision":"allow"}' }] } }
      },
    },
  }
  return { client, state }
}

const initPlugin = async (client: unknown) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "shield-bash-test-"))
  const prevCacheHome = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = cacheRoot
  try {
    const hooks = (await ShieldBash({ client, directory: cacheRoot } as never)) as Record<
      string,
      (input: unknown, output: unknown) => Promise<void>
    >
    return { gate: hooks["tool.execute.before"], cacheRoot }
  } finally {
    if (prevCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevCacheHome
  }
}

const bashCall = (
  command: string,
  sessionID: string,
): [{ tool: string; sessionID: string; callID: string }, { args: { command: string } }] => [
  { tool: "bash", sessionID, callID: command },
  { args: { command } },
]

describe("judge session lifecycle", () => {
  test("concurrent bash calls from one root share a single judge child", async () => {
    const { client, state } = makeClient({ "root-1": {} })
    const { gate } = await initPlugin(client)
    // Three parallel tool calls, as in one assistant message. Without the
    // in-flight memoization every call creates its own judge session.
    await Promise.all([
      gate(...bashCall("cmd-a", "root-1")),
      gate(...bashCall("cmd-b", "root-1")),
      gate(...bashCall("cmd-c", "root-1")),
    ])
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
    expect(state.prompts).toBe(3)
  })

  test("subagent sessions share their root's judge session", async () => {
    const { client, state } = makeClient({ "root-1": {}, "sub-1": { parentID: "root-1" } })
    const { gate } = await initPlugin(client)
    await gate(...bashCall("cmd-a", "sub-1"))
    await gate(...bashCall("cmd-b", "root-1"))
    await gate(...bashCall("cmd-c", "sub-1"))
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
  })

  test("each root session gets its own judge child", async () => {
    const { client, state } = makeClient({ "root-1": {}, "root-2": {} })
    const { gate } = await initPlugin(client)
    await Promise.all([
      gate(...bashCall("cmd-a", "root-1")),
      gate(...bashCall("cmd-b", "root-2")),
    ])
    expect(state.creates).toBe(2)
    expect(state.createdParents.sort()).toEqual(["root-1", "root-2"])
  })

  test("nested subagents resolve to the root, and walks are memoized", async () => {
    const { client, state } = makeClient({
      "root-1": {},
      "sub-1": { parentID: "root-1" },
      "sub-2": { parentID: "sub-1" },
      "sub-3": { parentID: "root-1" },
    })
    const { gate } = await initPlugin(client)
    await gate(...bashCall("cmd-a", "sub-2")) // walks sub-2 -> sub-1 -> root-1
    const getsAfterFirst = state.gets
    await gate(...bashCall("cmd-b", "sub-1")) // memoized by the first walk
    await gate(...bashCall("cmd-c", "sub-3")) // only sub-3 is a new hop
    expect(state.creates).toBe(1)
    expect(state.createdParents).toEqual(["root-1"])
    expect(state.gets).toBe(getsAfterFirst + 1)
  })

  test("a cached verdict skips the root lookup, the judge session, and the prompt", async () => {
    const { client, state } = makeClient({ "root-1": {} })
    const { gate } = await initPlugin(client)
    await gate(...bashCall("cmd-a", "root-1"))
    const counts = { ...state }
    await gate(...bashCall("cmd-a", "root-1"))
    expect(state).toEqual(counts)
  })

  test("failed judge session creation is retried on the next call", async () => {
    const { client, state } = makeClient({ "root-1": {} }, { failFirstCreate: true })
    const { gate } = await initPlugin(client)
    // failure defaults to deny, so the first call throws (fail-closed)
    await expect(gate(...bashCall("cmd-a", "root-1"))).rejects.toThrow("judge unavailable")
    await gate(...bashCall("cmd-a", "root-1"))
    expect(state.creates).toBe(2)
  })

  test("a session whose parent chain cannot be resolved is retried on the next call", async () => {
    const { client, state } = makeClient({ "root-1": {} })
    const { gate } = await initPlugin(client)
    // unknown session: the parent-chain lookup fails, fail-closed deny
    await expect(gate(...bashCall("cmd-a", "ghost-1"))).rejects.toThrow("failed to resolve session")
    // the failed lookup is not memoized; a known session still works
    await gate(...bashCall("cmd-b", "root-1"))
    expect(state.creates).toBe(1)
  })
})
