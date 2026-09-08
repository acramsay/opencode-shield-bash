import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Verdict } from "./lib"

export function sessionStorageOverride(): boolean | undefined {
  const value = process.env.SHIELD_BASH_STORE_SESSIONS?.trim().toLowerCase()
  if (!value) return undefined
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  throw new Error("SHIELD_BASH_STORE_SESSIONS must be true, false, 1, or 0.")
}

export function sessionStorageDirectory(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "shield-bash", "sessions")
}

export async function storeJudgeConversation(record: {
  sessionID: string
  command: string
  policy: string
  model: { providerID: string; modelID: string }
  response: string | null
  verdict: Verdict | null
  error: string | null
}): Promise<void> {
  // Hash caller-controlled IDs to keep file paths bounded and inside this directory.
  const session = createHash("sha256").update(record.sessionID).digest("hex")
  const directory = join(sessionStorageDirectory(), session)
  const path = join(directory, `${Date.now()}-${randomUUID()}.json`)
  let created = false
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(path, "wx", 0o600)
    created = true
    try {
      await file.writeFile(JSON.stringify({ timestamp: new Date().toISOString(), ...record }, null, 2) + "\n")
    } finally {
      await file.close()
    }
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => {})
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`shield-bash denied (could not store judge conversation).\nDetail: ${detail}`, { cause: error })
  }
}
