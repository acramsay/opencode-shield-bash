import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { type Counters, openDb, recordEvent } from "./lib"
import { CountersSchema, createRpcRegistrar, ShieldBash, statsFor } from "./rpc"

const dbPath = () => join(mkdtempSync(join(tmpdir(), "shield-bash-rpc-")), "sqlite.db")

const sampleCounters = (): Counters => ({
  allow: 42,
  deny: 3,
  ask: 2,
  allowCached: 30,
  denyCached: 2,
  askOnce: 1,
  askAlways: 1,
  askReject: 0,
  askPending: 1,
  denyByCategory: { DG1: 2, DG8: 1 },
  errorByKind: { timeout: 1, inference: 2 },
  waitMs: 12_300,
})

describe("CountersSchema", () => {
  test("round-trips a populated counters object", () => {
    const counters = sampleCounters()
    expect(CountersSchema.parse(JSON.parse(JSON.stringify(counters)))).toEqual(counters)
  })

  test("rejects a counters object missing a field", () => {
    const { waitMs: _waitMs, ...incomplete } = sampleCounters()
    expect(CountersSchema.safeParse(incomplete).success).toBe(false)
  })
})

describe("ShieldBash contract", () => {
  test("declares the stats method and verdict event", () => {
    expect(ShieldBash.id).toBe("shield-bash")
    expect(Object.keys(ShieldBash.methods)).toEqual(["stats"])
    expect(Object.keys(ShieldBash.events)).toEqual(["verdict"])
  })
})

describe("statsFor", () => {
  test("reads the persisted counters for a root", () => {
    const path = dbPath()
    const db = openDb(path)
    recordEvent(db, {
      sessionID: "root-1",
      command: "rm -rf /",
      ts: 1,
      outcome: "deny",
      cached: 0,
      category: "DG1",
      reason: "r",
      waitMs: 5,
    })
    recordEvent(db, { sessionID: "root-1", command: "ls", ts: 2, outcome: "allow", cached: 0, waitMs: 3 })
    recordEvent(db, { sessionID: "root-2", command: "ls", ts: 3, outcome: "allow", cached: 0 })

    const counters = statsFor(path, "root-1")
    expect(counters.allow).toBe(1)
    expect(counters.deny).toBe(1)
    expect(counters.denyByCategory).toEqual({ DG1: 1 })
    expect(counters.waitMs).toBe(8)
    expect(statsFor(path, "root-2").allow).toBe(1)
  })
})

describe("createRpcRegistrar", () => {
  test("registers once and reuses the handle across per-location setups", async () => {
    let calls = 0
    const fakeCtx = () =>
      ({
        rpc: {
          register: async () => {
            calls++
            return { events: { emit: async () => {} }, dispose: async () => {} }
          },
        },
      }) as unknown as Plugin.Context

    const register = createRpcRegistrar()
    const first = await register(fakeCtx(), dbPath())
    const second = await register(fakeCtx(), dbPath())
    expect(calls).toBe(1)
    expect(second).toBe(first)
  })
})
