import { describe, expect, test } from "bun:test"
import { emptyCounters, type Counters } from "./lib"
import { formatCounters, formatSummary, type CounterLine, type SummarySegment } from "./tui"

const populated: Counters = {
  allow: 42,
  deny: 3,
  ask: 2,
  allowCached: 30,
  denyCached: 2,
  askOnce: 1,
  askAlways: 1,
  askReject: 0,
  askPending: 0,
  denyByCategory: { DG1: 2, DG8: 1 },
  errorByKind: { timeout: 1, inference: 2 },
  waitMs: 12_300,
}

const plain = (segments: SummarySegment[]) => segments.map((segment) => segment.text).join("")

describe("formatSummary", () => {
  test("counts allow and deny", () => {
    expect(plain(formatSummary(emptyCounters()))).toBe("0 ✓   0 🛡")
    expect(plain(formatSummary(populated))).toBe("42 ✓   3 🛡")
  })

  test("tags each count and icon with a role", () => {
    expect(formatSummary(populated)).toEqual([
      { text: "42 ✓", role: "allow" },
      { text: "   3 🛡", role: "deny" },
    ])
  })
})

describe("formatCounters", () => {
  const rendered = (lines: CounterLine[]) =>
    lines.map((line) => `${line.label}: ${plain(line.segments)}`)

  test("zero state renders every line", () => {
    expect(rendered(formatCounters(emptyCounters()))).toEqual([
      "Cached: 0 ✓   0 🛡",
      "Questions & Errors: 0 ?   0 x",
      "Wait Time: 0.0s",
    ])
  })

  test("populated state matches the spec shape", () => {
    expect(rendered(formatCounters(populated))).toEqual([
      "Cached: 30 ✓   2 🛡",
      "Questions & Errors: 2 ?   3 x",
      "Wait Time: 12.3s",
    ])
  })

  test("colors each metric by role", () => {
    expect(formatCounters(populated)[0].segments).toEqual([
      { text: "30 ✓", role: "allow" },
      { text: "   2 🛡", role: "deny" },
    ])
    expect(formatCounters(populated)[1].segments).toEqual([
      { text: "2 ?", role: "ask" },
      { text: "   3 x", role: "error" },
    ])
  })

  test("the error metric is red only when non-zero", () => {
    expect(formatCounters(emptyCounters())[1].segments[1]).toEqual({ text: "   0 x", role: "muted" })
    expect(formatCounters(populated)[1].segments[1]).toEqual({ text: "   3 x", role: "error" })
  })

  test("wait formats to one decimal of a second", () => {
    expect(formatCounters({ ...emptyCounters(), waitMs: 1_000 })[2].segments[0].text).toBe("1.0s")
    expect(formatCounters({ ...emptyCounters(), waitMs: 123_456 })[2].segments[0].text).toBe("123.5s")
  })
})
