import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CacheEntry, defaultConfig, POLICY_PROMPT, parseVerdictText, readCache, saveCache } from "./lib"

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
  const cachePath = () => join(mkdtempSync(join(tmpdir(), "shield-bash-")), "verdicts.json")

  test("round-trips entries through save and read", async () => {
    const path = cachePath()
    const entry: CacheEntry = {
      verdict: { decision: "deny", category: "DG8", reason: "global install", alternative: null },
      ts: Date.now(),
    }
    await saveCache(path, new Map([["npm i -g", entry]]))
    const read = await readCache(path, 3_600_000)
    expect(read.get("npm i -g")).toEqual(entry)
  })

  test("drops expired entries on read", async () => {
    const path = cachePath()
    await saveCache(path, new Map([["old", { verdict: { decision: "allow", category: null, reason: "", alternative: null }, ts: 0 }]]))
    expect((await readCache(path, 1_000)).size).toBe(0)
  })

  test("returns an empty map for a missing file", async () => {
    expect((await readCache(join(cachePath(), "nope.json"), 3_600_000)).size).toBe(0)
  })

  test("caps the cache at 1000 entries, evicting oldest inserted", async () => {
    const path = cachePath()
    const map = new Map<string, CacheEntry>()
    for (let i = 0; i < 1005; i++) {
      map.set(`cmd-${i}`, { verdict: { decision: "allow", category: null, reason: "", alternative: null }, ts: Date.now() })
    }
    await saveCache(path, map)
    const read = await readCache(path, 3_600_000)
    expect(read.size).toBe(1000)
    expect(read.has("cmd-0")).toBe(false)
    expect(read.has("cmd-4")).toBe(false)
    expect(read.has("cmd-5")).toBe(true)
    expect(read.has("cmd-1004")).toBe(true)
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
