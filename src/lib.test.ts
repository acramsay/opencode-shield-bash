import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deleteSessionEvents,
  emptyCounters,
  listRecordedSessions,
  loadCounters,
  loadDedup,
  openDb,
  POLICY_PROMPT,
  parseConfig,
  parseVerdictText,
  pruneOrphanEvents,
  recordEvent,
  setEventResolution,
  type ShieldEvent,
} from "./lib"

const dbPath = () => join(mkdtempSync(join(tmpdir(), "shield-bash-")), "sqlite.db")
const freshDb = () => openDb(dbPath())

const event = (
  over: Partial<ShieldEvent> & Pick<ShieldEvent, "sessionID" | "command" | "outcome">,
): ShieldEvent => ({ ts: 1, cached: 0, ...over })

describe("parseVerdictText", () => {
  test("parses a bare allow verdict", () => {
    expect(parseVerdictText('{"decision":"allow"}')).toEqual({
      decision: "allow",
      category: null,
      reason: "",
      alternative: null,
    })
  })

  test("parses a deny verdict with all fields", () => {
    expect(
      parseVerdictText('{"decision":"deny","category":"DG1","reason":"rm -rf /","alternative":"rm ./path"}'),
    ).toEqual({
      decision: "deny",
      category: "DG1",
      reason: "rm -rf /",
      alternative: "rm ./path",
    })
  })

  test("parses an ask verdict", () => {
    expect(parseVerdictText('{"decision":"ask","reason":"looks risky"}')).toEqual({
      decision: "ask",
      category: null,
      reason: "looks risky",
      alternative: null,
    })
  })

  test("strips markdown fences and surrounding prose", () => {
    const text = 'Here is the verdict:\n```json\n{"decision":"allow"}\n```\nDone.'
    expect(parseVerdictText(text).decision).toBe("allow")
  })

  test("parses a batched reply carrying several verdicts", () => {
    // Regression: batched replies used to fail JSON.parse, denying
    // commands the judge had allowed.
    const batch = '{"decision":"allow"}\n{"decision":"allow"}\n{"decision":"allow"}'
    expect(parseVerdictText(batch).decision).toBe("allow")
  })

  test("takes the first object as the verdict when several arrive", () => {
    const text =
      '{"decision":"deny","category":"DG3","reason":"pipes curl into bash"}\n{"decision":"allow"}'
    const verdict = parseVerdictText(text)
    expect(verdict.decision).toBe("deny")
    expect(verdict.category).toBe("DG3")
  })

  test("skips a prose brace that is not JSON and uses the real verdict", () => {
    const text = 'Here {is} the verdict: {"decision":"allow"}'
    expect(parseVerdictText(text).decision).toBe("allow")
  })

  test("throws on an invalid verdict even when a valid one follows", () => {
    expect(() => parseVerdictText('{"decision":"maybe"} {"decision":"allow"}')).toThrow(
      "unexpected decision value",
    )
  })

  test("braces inside JSON strings do not end the object early", () => {
    const text =
      '{"decision":"deny","category":"DG1","reason":"rm -rf {~/dir}","alternative":"rm ./dir"}'
    const verdict = parseVerdictText(text)
    expect(verdict.decision).toBe("deny")
    expect(verdict.reason).toBe("rm -rf {~/dir}")
  })

  test("throws when no JSON object is present", () => {
    expect(() => parseVerdictText("no verdict here")).toThrow("missing JSON object")
  })

  test("throws on an unexpected decision value", () => {
    expect(() => parseVerdictText('{"decision":"maybe"}')).toThrow("unexpected decision value")
  })

  test("throws when a deny verdict has no reason", () => {
    expect(() => parseVerdictText('{"decision":"deny","category":"DG1"}')).toThrow("missing reason")
  })

  test("throws when an ask verdict has no reason", () => {
    expect(() => parseVerdictText('{"decision":"ask"}')).toThrow("missing reason")
  })
})

describe("event storage", () => {
  test("records an event and returns its row id", () => {
    const db = freshDb()
    const id = recordEvent(db, event({ sessionID: "root-1", command: "ls", outcome: "allow" }))
    expect(id).toBe(1)
    const row = db.query("SELECT * FROM shield_events WHERE id = ?").get(id) as Record<string, unknown>
    expect(row.command).toBe("ls")
    expect(row.outcome).toBe("allow")
    expect(row.cached).toBe(0)
    expect(row.wait_ms).toBe(0)
    expect(row.resolution).toBeNull()
    expect(row.error_kind).toBeNull()
  })

  test("persists the optional fields", () => {
    const db = freshDb()
    const id = recordEvent(
      db,
      event({
        sessionID: "root-1",
        command: "npm i -g",
        outcome: "deny",
        category: "DG8",
        reason: "global install",
        alternative: "npm i",
        waitMs: 42,
      }),
    )
    const row = db.query("SELECT * FROM shield_events WHERE id = ?").get(id) as Record<string, unknown>
    expect(row.category).toBe("DG8")
    expect(row.reason).toBe("global install")
    expect(row.alternative).toBe("npm i")
    expect(row.wait_ms).toBe(42)
  })

  test("scopes rows to the session id", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "ls", outcome: "allow" }))
    recordEvent(db, event({ sessionID: "root-2", command: "ls", outcome: "allow" }))
    deleteSessionEvents(db, "root-1")
    const remaining = db.query("SELECT session_id FROM shield_events").all() as { session_id: string }[]
    expect(remaining.map((r) => r.session_id)).toEqual(["root-2"])
  })

  test("lists each recorded session once", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "a", outcome: "allow" }))
    recordEvent(db, event({ sessionID: "root-1", command: "b", outcome: "deny" }))
    recordEvent(db, event({ sessionID: "root-2", command: "c", outcome: "allow" }))
    expect(listRecordedSessions(db).sort()).toEqual(["root-1", "root-2"])
  })

  test("lists nothing for an empty log", () => {
    expect(listRecordedSessions(freshDb())).toEqual([])
  })

  test("updates an ask's resolution in place", () => {
    const db = freshDb()
    const id = recordEvent(db, event({ sessionID: "root-1", command: "x", outcome: "ask" }))
    setEventResolution(db, id, "always")
    const row = db.query("SELECT resolution FROM shield_events WHERE id = ?").get(id) as {
      resolution: string
    }
    expect(row.resolution).toBe("always")
  })

  test("prunes every session not in the live set", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "a", outcome: "allow" }))
    recordEvent(db, event({ sessionID: "root-2", command: "b", outcome: "allow" }))
    expect(pruneOrphanEvents(db, ["root-1"])).toBe(1)
    const sessions = db.query("SELECT session_id FROM shield_events").all() as { session_id: string }[]
    expect(sessions.map((r) => r.session_id)).toEqual(["root-1"])
  })

  test("prunes everything when no sessions are live", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "a", outcome: "allow" }))
    expect(pruneOrphanEvents(db, [])).toBe(1)
    expect(db.query("SELECT COUNT(*) AS n FROM shield_events").get()).toEqual({ n: 0 })
  })

  test("shares one handle per resolved path", () => {
    const path = dbPath()
    expect(openDb(path)).toBe(openDb(path))
  })

  test("drops the legacy verdicts table and turns on WAL", () => {
    const path = dbPath()
    const raw = new Database(path, { create: true })
    raw.run("CREATE TABLE verdicts (x)")
    raw.close()
    const db = openDb(path)
    const names = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]
    const tableNames = names.map((n) => n.name)
    expect(tableNames).toContain("shield_events")
    expect(tableNames).not.toContain("verdicts")
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  })
})

describe("loadCounters", () => {
  test("returns zeros for an unknown session", () => {
    expect(loadCounters(freshDb(), "ghost")).toEqual(emptyCounters())
  })

  test("aggregates outcomes, cached hits, asks, categories, errors, and waits", () => {
    const db = freshDb()
    const rec = (over: Partial<ShieldEvent> & Pick<ShieldEvent, "command" | "outcome">) =>
      recordEvent(db, event({ sessionID: "root-1", ...over }))

    rec({ command: "a", outcome: "allow", waitMs: 10 })
    rec({ command: "b", outcome: "deny", category: "DG1", waitMs: 20 })
    rec({ command: "c", outcome: "allow", cached: 1 })
    rec({ command: "d", outcome: "deny", cached: 1, category: "DG1" })
    rec({ command: "e", outcome: "ask", resolution: null })
    rec({ command: "f", outcome: "ask", resolution: "once" })
    rec({ command: "g", outcome: "ask", resolution: "always" })
    rec({ command: "h", outcome: "ask", resolution: "reject" })
    rec({ command: "i", outcome: "deny", errorKind: "timeout", waitMs: 30 })
    rec({ command: "j", outcome: "allow", errorKind: "inference", waitMs: 40 })

    expect(loadCounters(db, "root-1")).toEqual({
      allow: 2,
      deny: 2,
      ask: 4,
      allowCached: 1,
      denyCached: 1,
      askOnce: 1,
      askAlways: 1,
      askReject: 1,
      askPending: 1,
      // DG1 counts once for the fresh deny and once for the cached deny.
      denyByCategory: { DG1: 2 },
      errorByKind: { timeout: 1, inference: 1 },
      waitMs: 100,
    })
  })
})

describe("loadDedup", () => {
  const verdicts = (db: Database) =>
    Object.fromEntries([...loadDedup(db, "root-1")].map(([k, v]) => [k, v]))

  test("caches judge allow and deny, ignoring asks, errors, and cache hits", () => {
    const db = freshDb()
    const rec = (over: Partial<ShieldEvent> & Pick<ShieldEvent, "command" | "outcome">) =>
      recordEvent(db, event({ sessionID: "root-1", ...over }))

    rec({ command: "allow-cmd", outcome: "allow" })
    rec({ command: "deny-cmd", outcome: "deny", category: "DG3", reason: "curl | bash" })
    rec({ command: "ask-pending", outcome: "ask", resolution: null })
    rec({ command: "ask-once", outcome: "ask", resolution: "once" })
    rec({ command: "err-cmd", outcome: "deny", errorKind: "timeout" })
    rec({ command: "cache-hit", outcome: "allow", cached: 1 })

    expect(verdicts(db)).toEqual({
      "allow-cmd": { decision: "allow", category: null, reason: "", alternative: null },
      "deny-cmd": { decision: "deny", category: "DG3", reason: "curl | bash", alternative: null },
    })
  })

  test("reconstructs a resolved always ask as a cached allow", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "weird", outcome: "ask", resolution: "always" }))
    expect(verdicts(db)).toEqual({
      weird: { decision: "allow", category: null, reason: "", alternative: null },
    })
  })

  test("reconstructs a resolved reject ask as a cached deny", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "weird", outcome: "ask", resolution: "reject" }))
    expect(verdicts(db)).toEqual({
      weird: { decision: "deny", category: null, reason: "", alternative: null },
    })
  })

  test("the latest qualifying row per command wins", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "x", outcome: "deny", category: "DG1" }))
    recordEvent(db, event({ sessionID: "root-1", command: "x", outcome: "allow" }))
    expect(verdicts(db).x).toEqual({ decision: "allow", category: null, reason: "", alternative: null })
  })

  test("scopes dedup to the session id", () => {
    const db = freshDb()
    recordEvent(db, event({ sessionID: "root-1", command: "ls", outcome: "allow" }))
    recordEvent(db, event({ sessionID: "root-2", command: "ls", outcome: "deny" }))
    expect(loadDedup(db, "root-2").get("ls")?.decision).toBe("deny")
  })
})

describe("POLICY_PROMPT", () => {
  test("covers all eight deny categories", () => {
    for (const dg of ["DG1", "DG2", "DG3", "DG4", "DG5", "DG6", "DG7", "DG8"]) {
      expect(POLICY_PROMPT).toContain(dg)
    }
  })

  test("demands exactly one JSON object", () => {
    expect(POLICY_PROMPT).toContain("Return ONE JSON object")
    expect(POLICY_PROMPT).toContain("Return only the JSON object.")
  })

  test("describes the ask shape", () => {
    expect(POLICY_PROMPT).toContain('{"decision":"ask","reason":"one line"}')
  })
})

describe("parseConfig", () => {
  const base = { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" }

  test("applies defaults for the optional fields", () => {
    const config = parseConfig(base)
    expect(config.failure).toBe("deny")
    expect(config.timeoutMs).toBe(10_000)
    expect(config.dbPath.endsWith("shield-bash/sqlite.db")).toBe(true)
  })

  test("honors explicit values", () => {
    const config = parseConfig({ ...base, failure: "ask", timeoutMs: 5_000, dbPath: "/tmp/shield.db" })
    expect(config).toMatchObject({ failure: "ask", timeoutMs: 5_000, dbPath: "/tmp/shield.db" })
  })

  test("rejects missing required fields with a clear message", () => {
    expect(() => parseConfig({ modelID: "m" })).toThrow(/invalid plugin options.*providerID/)
  })

  test("rejects an invalid failure mode", () => {
    expect(() => parseConfig({ ...base, failure: "maybe" })).toThrow(/failure/)
  })

  test("rejects unknown keys so a typo cannot silently default", () => {
    expect(() => parseConfig({ ...base, failur: "deny" })).toThrow(/failur/)
  })

  test("rejects the removed ttlHours and renamed cachePath", () => {
    expect(() => parseConfig({ ...base, ttlHours: 1 })).toThrow(/ttlHours/)
    expect(() => parseConfig({ ...base, cachePath: "/tmp/x.db" })).toThrow(/cachePath/)
  })
})
