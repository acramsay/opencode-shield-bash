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

// `setup` runs once per location, and each location loads its own module instance,
// so this registers unconditionally. The host accepts the same id from several
// locations, and each location disposes only its own registration.
export function registerShieldBash(ctx: Plugin.Context, dbPath: string): Promise<ShieldBashRpc> {
  return ctx.rpc.register(ShieldBash, {
    stats: async ({ rootID }) => statsFor(dbPath, rootID),
  })
}
