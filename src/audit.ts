import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Verdict } from "./lib"

export function retentionDays(value: unknown): number {
  if (value === undefined) return 7
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * 86_400_000)) {
    throw new Error("Session retention must be a positive whole number of days within the safe numeric range.")
  }
  return value
}

export function sessionRetentionOverride(): number | undefined {
  const value = process.env.SHIELD_BASH_SESSION_RETENTION_DAYS?.trim()
  return value ? retentionDays(Number(value)) : undefined
}

async function removeExpiredConversations(days: number) {
  const root = sessionStorageDirectory()
  const cutoff = Date.now() - days * 86_400_000
  const sessions = await readdir(root, { withFileTypes: true })
  for (const session of sessions) {
    if (!session.isDirectory() || !/^[a-f0-9]{64}$/.test(session.name)) continue
    const directory = join(root, session.name)
    for (const file of await readdir(directory, { withFileTypes: true })) {
      // Only remove regular audit files created by this plugin, never symlinks
      // or unrelated files. Creation time is encoded in the filename.
      const match = /^(\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.exec(file.name)
      if (file.isFile() && match && Number(match[1]) <= cutoff) {
        await rm(join(directory, file.name), { force: true })
      }
    }
  }
}

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
}, days = 7): Promise<void> {
  days = retentionDays(days)
  // Hash caller-controlled IDs to keep file paths bounded and inside this directory.
  const session = createHash("sha256").update(record.sessionID).digest("hex")
  const directory = join(sessionStorageDirectory(), session)
  const path = join(directory, `${Date.now()}-${randomUUID()}.json`)
  let created = false
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await removeExpiredConversations(days)
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
