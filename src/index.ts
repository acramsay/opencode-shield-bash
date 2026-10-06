import type { Plugin } from "@opencode/plugin"
import { createJudge } from "./judge"
import { parseConfig, POLICY_PROMPT } from "./lib"

const ID = "shield-bash"

// The host's command tool is `shell`, but AFT registers its own under `bash`.
// Gate both names so neither shell surface bypasses the judge.
const SHELL_TOOLS = new Set(["shell", "bash"])

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const config = parseConfig(ctx.options)
  const judge = createJudge(ctx, config)

  // The judge runs as an ordinary session, but must not inherit the host's
  // agent prompt or tools. The context hook replaces the system prompt with the
  // policy, empties the tool set, and pins temperature to zero.
  await ctx.session.hook("context", (event) => {
    if (!judge.isJudgeSession(event.sessionID)) return
    event.system = [{ type: "text", text: POLICY_PROMPT }]
    for (const name of Object.keys(event.tools)) delete event.tools[name]
    event.options.temperature = 0
  })

  // failure:"ask" has no direct tool-hook equivalent, so execute.before flags
  // the call and the permission hook upgrades it to a real ask. A config rule
  // that hard-denies shell stays final: the hook never runs for it.
  const askHandoff = new Set<string>()
  await ctx.permission.hook("evaluate", (event) => {
    const callID = event.source?.type === "tool" ? event.source.id : undefined
    if (!callID || !askHandoff.has(callID)) return
    event.effect = "ask"
    event.message = "shield-bash: judge unavailable; confirm manually"
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

    let verdict
    try {
      verdict = await judge.decide(event.sessionID, command)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (config.failure === "allow") return
      if (config.failure === "ask") {
        askHandoff.add(event.id)
        return
      }
      throw new Error(`shield-bash denied (judge unavailable, fail-closed).\nDetail: ${reason}`)
    }
    if (verdict.decision === "deny") {
      const category = verdict.category ? `\nCategory: ${verdict.category}` : ""
      const alternative = verdict.alternative ? `\nAlternative: ${verdict.alternative}` : ""
      throw new Error(`shield-bash denied.${category}\nReason: ${verdict.reason}${alternative}`)
    }
  })

  await ctx.tool.hook("execute.after", (event) => {
    askHandoff.delete(event.id)
  })

  const controller = new AbortController()
  const subscription = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === "session.deleted") judge.deleteSession(event.data.sessionID)
    }
  })().catch(() => {})

  return async () => {
    controller.abort()
    await subscription
    judge.close()
  }
}

export default { id: ID, setup } satisfies Plugin.Plugin

function readCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null
  const command = (input as { command?: unknown }).command
  return typeof command === "string" && command.trim() !== "" ? command : null
}
