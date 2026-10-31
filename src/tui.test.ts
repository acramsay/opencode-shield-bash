import { describe, expect, test } from "bun:test"
import { emptyCounters, type Counters } from "./lib"
import { formatCounters } from "./tui"

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

describe("formatCounters", () => {
  test("zero state renders every line with placeholders", () => {
    expect(formatCounters(emptyCounters())).toEqual([
      " 0 ✓   0 ✕   0 ?",
      " cached:  0✓  0✕",
      " denied:  none",
      " asked:   0 once  0 always  0 reject",
      " errors:  none",
      " wait:    0.0s",
    ])
  })

  test("populated state matches the spec shape", () => {
    expect(formatCounters(populated)).toEqual([
      " 42 ✓   3 ✕   2 ?",
      " cached:  30✓  2✕",
      " denied:  DG1×2 DG8×1",
      " asked:   1 once  1 always  0 reject",
      " errors:  1 timeout  2 inference",
      " wait:    12.3s",
    ])
  })

  test("categories and error kinds are sorted deterministically", () => {
    const counters: Counters = {
      ...emptyCounters(),
      denyByCategory: { DG8: 1, DG1: 2, DG3: 5 },
      errorByKind: { inference: 2, "invalid-verdict": 1, timeout: 3 },
    }
    const lines = formatCounters(counters)
    expect(lines[2]).toBe(" denied:  DG1×2 DG3×5 DG8×1")
    expect(lines[4]).toBe(" errors:  3 timeout  2 inference  1 invalid-verdict")
  })

  test("unknown error kinds sort after known ones", () => {
    const counters: Counters = {
      ...emptyCounters(),
      errorByKind: { zebra: 1, timeout: 2 },
    }
    expect(formatCounters(counters)[4]).toBe(" errors:  2 timeout  1 zebra")
  })

  test("pending asks appear only when non-zero", () => {
    const pending: Counters = { ...emptyCounters(), askPending: 2 }
    expect(formatCounters(pending)[3]).toBe(" asked:   0 once  0 always  0 reject  2 pending")
    expect(formatCounters(emptyCounters())[3]).not.toContain("pending")
  })

  test("wait formats to one decimal of a second", () => {
    expect(formatCounters({ ...emptyCounters(), waitMs: 1_000 })[5]).toBe(" wait:    1.0s")
    expect(formatCounters({ ...emptyCounters(), waitMs: 123_456 })[5]).toBe(" wait:    123.5s")
  })
})
