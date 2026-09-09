import { Rpc } from "@opencode/plugin/rpc"

export type CheckStatus = {
  state: "checking" | "allowed" | "blocked" | "error" | "approval"
  reason: string
  detail: string
  cached: boolean
  outcome: "pending" | "allow" | "deny" | "ask"
  approvalRequired?: boolean
}

export type CheckRecord = CheckStatus & {
  sessionID: string
  callID: string
  command: string
  updatedAt: number
}

const recordSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    callID: { type: "string" },
    command: { type: "string" },
    updatedAt: { type: "number" },
    state: { type: "string", enum: ["checking", "allowed", "blocked", "error", "approval"] },
    reason: { type: "string" },
    detail: { type: "string" },
    cached: { type: "boolean" },
    outcome: { type: "string", enum: ["pending", "allow", "deny", "ask"] },
    approvalRequired: { type: "boolean" },
  },
  required: ["sessionID", "callID", "command", "updatedAt", "state", "reason", "detail", "cached", "outcome"],
  additionalProperties: false,
} as const

export const StatusRpc = Rpc.define({
  id: "shield-bash.status",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "array", items: recordSchema },
    },
  },
  events: { changed: { schema: recordSchema } },
})

// Commands and judge text are untrusted terminal content.
export function singleLine(text: string, limit = 90): string {
  const line = text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
}

export function statusLabel(status: CheckStatus): string {
  const permission = status.approvalRequired ? " · OpenCode approval required" : ""
  switch (status.state) {
    case "checking": return "◌ Shield: checking"
    case "allowed": return `✓ Shield: allowed${status.cached ? " (cached)" : ""}${permission}`
    case "blocked": return `✕ Shield: blocked — ${singleLine(status.reason.split(/[.!?](?:\s|$)|[\r\n]/)[0] ?? "") || "Denied by safety policy"}`
    case "approval": return "? Shield: approval needed — Safety judge unavailable"
    case "error": return `! Shield: ${status.outcome === "allow" ? "unchecked" : "blocked"} — ${singleLine(status.reason)}${permission}`
  }
}
