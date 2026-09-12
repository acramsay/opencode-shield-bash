import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultConfig,
  deleteSessionVerdicts,
  getCachedVerdict,
  openCache,
  POLICY_PROMPT,
  parseVerdictText,
  setCachedVerdict,
  Verdict,
} from "./lib"

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
})

describe("verdict cache", () => {
  const cachePath = () => join(mkdtempSync(join(tmpdir(), "shield-bash-")), "verdicts.db")
  const allow: Verdict = { decision: "allow", category: null, reason: "", alternative: null }

  test("round-trips a verdict through set and get", () => {
    const db = openCache(cachePath())
    const entry: Verdict = { decision: "deny", category: "DG8", reason: "global install", alternative: null }
    setCachedVerdict(db, "root-1", "npm i -g", entry)
    expect(getCachedVerdict(db, "root-1", "npm i -g", 3_600_000)).toEqual(entry)
  })

  test("scopes verdicts to the session id", () => {
    const db = openCache(cachePath())
    setCachedVerdict(db, "root-1", "ls", allow)
    expect(getCachedVerdict(db, "root-2", "ls", 3_600_000)).toBeNull()
  })

  test("drops and deletes an expired entry on read", () => {
    const db = openCache(cachePath())
    setCachedVerdict(db, "root-1", "old", allow)
    db.run("UPDATE verdicts SET ts = 0")
    expect(getCachedVerdict(db, "root-1", "old", 1_000)).toBeNull()
    expect(db.query("SELECT COUNT(*) AS n FROM verdicts").get() as { n: number }).toEqual({ n: 0 })
  })

  test("returns null for a missing entry", () => {
    const db = openCache(cachePath())
    expect(getCachedVerdict(db, "root-1", "nope", 3_600_000)).toBeNull()
  })

  test("caps the cache at 1000 rows, evicting oldest first", () => {
    const db = openCache(cachePath())
    for (let i = 0; i < 1005; i++) setCachedVerdict(db, "root-1", `cmd-${i}`, allow)
    const count = db.query("SELECT COUNT(*) AS n FROM verdicts").get() as { n: number }
    expect(count.n).toBe(1000)
    expect(getCachedVerdict(db, "root-1", "cmd-4", 3_600_000)).toBeNull()
    expect(getCachedVerdict(db, "root-1", "cmd-5", 3_600_000)).not.toBeNull()
    expect(getCachedVerdict(db, "root-1", "cmd-1004", 3_600_000)).not.toBeNull()
  })

  test("deleteSessionVerdicts removes only that session's rows", () => {
    const db = openCache(cachePath())
    setCachedVerdict(db, "root-1", "ls", allow)
    setCachedVerdict(db, "root-2", "ls", allow)
    deleteSessionVerdicts(db, "root-1")
    expect(getCachedVerdict(db, "root-1", "ls", 3_600_000)).toBeNull()
    expect(getCachedVerdict(db, "root-2", "ls", 3_600_000)).not.toBeNull()
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
})

describe("defaultConfig", () => {
  test("uses a 24h TTL unless overridden", () => {
    expect(defaultConfig().cacheTtlMs).toBe(24 * 3_600_000)
  })
})
