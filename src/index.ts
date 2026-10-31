import type { Plugin } from "@opencode/plugin"
import { createJudge } from "./judge"
import { parseConfig, POLICY_PROMPT } from "./lib"
import { registerShieldBash } from "./rpc"

const ID = "shield-bash"

// The host's command tool is `shell`, but AFT registers its own under `bash`.
// Gate both names so neither shell surface bypasses the judge.
const SHELL_TOOLS = new Set(["shell", "bash"])

const JUDGE_UNAVAILABLE = "shield-bash: judge unavailable; confirm manually"

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const config = parseConfig(ctx.options)
  const rpc = await registerShieldBash(ctx, config.dbPath)
  const judge = createJudge(ctx, config, (rootID, counters) => {
    // The judge keeps mutating this object, so snapshot it for the payload.
    void rpc.events
      .emit("verdict", { rootID, counters: structuredClone(counters) })
      .catch(() => {})
  })

  // The judge runs as an ordinary session, but must not inherit the host's
  // agent prompt or tools. The context hook replaces the system prompt with the
  // policy, empties the tool set, and pins temperature to zero.
  await ctx.session.hook("context", (event) => {
    if (!judge.isJudgeSession(event.sessionID)) return
    event.system = [{ type: "text", text: POLICY_PROMPT }]
    for (const name of Object.keys(event.tools)) delete event.tools[name]
    event.options.temperature = 0
  })

  // An ask has no direct tool-hook equivalent, so execute.before flags the call
  // and the permission hook turns it into a real ask. The map carries the prompt
  // text to show. A config rule that hard-denies shell wins, since the hook never
  // runs for it.
  const askHandoff = new Map<string, string>()
  await ctx.permission.hook("evaluate", (event) => {
    const callID = event.source?.type === "tool" ? event.source.id : undefined
    if (!callID) return
    const message = askHandoff.get(callID)
    if (message === undefined) return
    event.effect = "ask"
    event.message = message
    askHandoff.delete(callID) // consume-once
  })

  await ctx.tool.hook("execute.before", async (event) => {
    if (!SHELL_TOOLS.has(event.tool)) return
    // The judge has no tools, so this is unreachable today; deny anyway rather
    // than risk a future change re-gating the judge and deadlocking its verdict.
    if (judge.isJudgeSession(event.sessionID)) {
      throw new Error("shield-bash: the judge cannot run commands.")
    }
    const command = readCommand(event.input)
    if (command === null) return

    const decision = await judge.decide(event.sessionID, command)

    if (decision.outcome === "allow") return

    if (decision.outcome === "deny") {
      if (decision.errorKind || !decision.verdict) {
        throw new Error(
          `shield-bash denied (judge unavailable, fail-closed).\nDetail: ${decision.errorKind ?? "unknown error"}`,
        )
      }
      const { category, reason, alternative } = decision.verdict
      const categoryLine = category ? `\nCategory: ${category}` : ""
      const alternativeLine = alternative ? `\nAlternative: ${alternative}` : ""
      throw new Error(`shield-bash denied.${categoryLine}\nReason: ${reason}${alternativeLine}`)
    }

    judge.trackAsk(event.id, {
      rowId: decision.rowId,
      rootID: decision.rootID,
      command,
      sessionID: event.sessionID,
    })
    askHandoff.set(
      event.id,
      decision.errorKind ? JUDGE_UNAVAILABLE : decision.verdict?.reason.trim() || JUDGE_UNAVAILABLE,
    )
  })

  await ctx.tool.hook("execute.after", (event) => {
    askHandoff.delete(event.id)
  })

  const controller = new AbortController()
  const subscription = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === "session.deleted") judge.deleteSession(event.data.sessionID)
      else if (event.type === "permission.asked") judge.onPermissionAsked(event.data)
      else if (event.type === "permission.replied") judge.onPermissionReplied(event.data)
    }
  })().catch(() => {})

  return async () => {
    controller.abort()
    await subscription
    judge.close()
    await rpc.dispose()
  }
}

export default { id: ID, setup } satisfies Plugin.Plugin

function readCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null
  const command = (input as { command?: unknown }).command
  return typeof command === "string" && command.trim() !== "" ? command : null
}
