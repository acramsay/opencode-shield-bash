import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { POLICY_PROMPT, parseVerdictText } from "../src/lib"

// Drives fixture commands through a persistent judge session on the running
// opencode web server. Set SHIELD_BASH_TEST_OPENCODE_URL to point at a
// different instance.
const OPENCODE_URL = process.env.SHIELD_BASH_TEST_OPENCODE_URL ?? "http://localhost:4096"
const LATENCY_BUDGET_P95_MS = 60000 // judgment now goes through a provider; budget comes later

type Fixture = { command: string; expect: "allow" | "deny" }
const here = dirname(fileURLToPath(import.meta.url))
const fixtures = (await Bun.file(join(here, "fixtures.json")).json()) as Fixture[]

// Same model the plugin resolves, so tests judge with the configured provider
// rather than whatever opencode default the host session happens to use.
// SHIELD_BASH_TEST_CONFIG points at a shield-bash.json (defaults to the
// committed test fixture); SHIELD_BASH_MODEL="provider/model" overrides both,
// with the same provider/model split the plugin uses.
const resolveModel = async () => {
  const configPath = process.env.SHIELD_BASH_TEST_CONFIG ?? join(here, "shield-bash.json")
  const model = (await Bun.file(configPath).json()) as { providerID: string; modelID: string }
  const envOverride = process.env.SHIELD_BASH_MODEL?.split("/")
  if (envOverride?.length && envOverride[0]) {
    const modelID = envOverride.slice(1).join("/")
    if (modelID) return { providerID: envOverride[0], modelID }
  }
  return model
}
const model = await resolveModel()

// Repo root, derived from this file's location — works on any machine.
const directory = resolve(here, "..")

const quickPing = async () => {
  try {
    const res = await fetch(`${OPENCODE_URL}/path`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const ensureJudgeSession = async () => {
  const res = await fetch(`${OPENCODE_URL}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "shield-bash fixture judge" }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`failed to create judge session: HTTP ${res.status}`)
  const session = (await res.json()) as { id: string }
  return session.id
}

const judge = async (sessionID: string, command: string) => {
  let lastError: unknown
  // The configured model occasionally aborts prompts (~5s, provider-side);
  // a single retry absorbs that without masking genuinely-wrong verdicts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${OPENCODE_URL}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system: POLICY_PROMPT,
            parts: [{ type: "text", text: `Command: ${command}\nReturn the JSON verdict.` }],
            model,
          }),
        },
      )
      if (!res.ok) throw new Error(`session prompt failed: HTTP ${res.status}`)
      const payload = (await res.json()) as {
        parts: Array<{ type: string; text?: string }>
      }
      const textPart = payload.parts.find((p) => p.type === "text")
      if (!textPart?.text) throw new Error("session returned no text part")
      return parseVerdictText(textPart.text)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

describe("shield-bash session judgments", async () => {
  // Gate on server reachability first; otherwise setup would throw during
  // collection even though we registered a skip.
  const reachable = await quickPing()
  if (!reachable) {
    console.error(
      `opencode web not reachable at ${OPENCODE_URL} — start it with: opencode serve --port 4096 --hostname 127.0.0.1`,
    )
    test.skip("server unreachable", () => {})
    return
  }

  const durations: number[] = []

  // Serial: parallel judge prompts against the provider abort around the
  // server's ~5s concurrency limit, producing random failures.
  for (const fixture of fixtures) {
    test.serial(
      `judge "${fixture.command}"`,
      async () => {
      // Fresh session per fixture: a reused session accumulates prior commands
      // and the judge recycles earlier reasoning into later verdicts.
      const sessionID = await ensureJudgeSession()
      const started = Date.now()
      const verdict = await judge(sessionID, fixture.command)
      durations.push(Date.now() - started)
      if (verdict.decision !== fixture.expect) {
        throw new Error(
          `unexpected verdict for "${fixture.command}": expected ${fixture.expect}, got ${JSON.stringify(verdict)}`,
        )
      }
    },
      { timeout: 30_000 }, // must cover p95 judge latency plus one retry
    )
  }

  test(`p95 latency under ${LATENCY_BUDGET_P95_MS}ms`, () => {
    const sorted = durations.toSorted((a, b) => a - b)
    const p95 = sorted.at(Math.ceil(sorted.length * 0.95) - 1)
    console.log(`latency: n=${sorted.length} median=${sorted[Math.floor(sorted.length / 2)]}ms p95=${p95}ms`)
    expect(p95).toBeLessThan(LATENCY_BUDGET_P95_MS)
  })
})
