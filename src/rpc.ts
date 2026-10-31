import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { loadCounters, openDb, type Counters } from "./lib"

export const CountersSchema = z.object({
  allow: z.number(),
  deny: z.number(),
  ask: z.number(),
  allowCached: z.number(),
  denyCached: z.number(),
  askOnce: z.number(),
  askAlways: z.number(),
  askReject: z.number(),
  askPending: z.number(),
  denyByCategory: z.record(z.string(), z.number()),
  errorByKind: z.record(z.string(), z.number()),
  waitMs: z.number(),
})

export const ShieldBash = Rpc.define({
  id: "shield-bash",
  methods: {
    stats: { input: z.object({ rootID: z.string() }), output: CountersSchema },
  },
  events: {
    verdict: { schema: z.object({ rootID: z.string(), counters: CountersSchema }) },
  },
})

export type VerdictEvent = { rootID: string; counters: Counters }

export type ShieldBashRpc = {
  events: { emit: (name: "verdict", data: VerdictEvent) => Promise<void> }
  dispose: () => Promise<void>
}

// Reads from the shared DB, not an instance's memory, so it stays correct no
// matter which per-location instance handles the call.
export function statsFor(dbPath: string, rootID: string): Counters {
  return loadCounters(openDb(dbPath), rootID)
}

// `setup` may run once per location in a single process. The host may reject a
// second registration on the same id, so only the first call registers.
export function createRpcRegistrar() {
  let registration: Promise<ShieldBashRpc> | null = null
  return function registerShieldBash(ctx: Plugin.Context, dbPath: string): Promise<ShieldBashRpc> {
    if (registration) return registration
    registration = ctx.rpc
      .register(ShieldBash, {
        stats: async ({ rootID }) => statsFor(dbPath, rootID),
      })
      .catch((err) => {
        registration = null // a later setup may retry
        throw err
      })
    return registration
  }
}

export const registerShieldBash = createRpcRegistrar()
