import { describe, expect, it } from "vitest"
import {
  DASHBOARD_SECTIONS,
  DEFAULT_DASHBOARD_SECTION_ORDER,
  moveDashboardSection,
  normalizeDashboardSectionOrder
} from "./preferences.js"

/**
 * A cached dashboard order can outlive a release that adds a section. The
 * normalizer is what keeps `/today` rendering every section exactly once.
 */

describe("normalizeDashboardSectionOrder", () => {
  it("preserves a valid full permutation", () => {
    const reordered = ["notes", "tasks", "habits", "events", "reminders"]
    expect(normalizeDashboardSectionOrder(reordered)).toEqual(reordered)
  })

  it("drops unknown and duplicate ids and appends missing sections", () => {
    expect(
      normalizeDashboardSectionOrder(["notes", "notes", "search", "tasks"])
    ).toEqual(["notes", "tasks", ...DASHBOARD_SECTIONS.filter(
      (section) => section !== "notes" && section !== "tasks"
    )])
  })

  it("falls back to the product order for a missing/empty value", () => {
    expect(normalizeDashboardSectionOrder(undefined)).toEqual([
      ...DEFAULT_DASHBOARD_SECTION_ORDER
    ])
    expect(normalizeDashboardSectionOrder([])).toEqual([
      ...DEFAULT_DASHBOARD_SECTION_ORDER
    ])
  })
})

describe("moveDashboardSection", () => {
  it("swaps a section with its neighbour and returns a full permutation", () => {
    expect(
      moveDashboardSection(DEFAULT_DASHBOARD_SECTION_ORDER, "notes", "up")
    ).toEqual(["tasks", "events", "reminders", "notes", "habits"])
    expect(
      moveDashboardSection(DEFAULT_DASHBOARD_SECTION_ORDER, "tasks", "down")
    ).toEqual(["events", "tasks", "reminders", "habits", "notes"])
  })

  it("normalizes stale, duplicate or unknown input before moving", () => {
    const next = moveDashboardSection(
      ["notes", "notes", "search", "tasks"],
      "tasks",
      "up"
    )
    expect(next).toEqual(["tasks", "notes", "events", "reminders", "habits"])
    expect(new Set(next).size).toBe(DASHBOARD_SECTIONS.length)
  })

  it("is a no-op at the ends, so the control cannot wrap into a duplicate", () => {
    expect(
      moveDashboardSection(DEFAULT_DASHBOARD_SECTION_ORDER, "tasks", "up")
    ).toEqual([...DEFAULT_DASHBOARD_SECTION_ORDER])
    expect(
      moveDashboardSection(DEFAULT_DASHBOARD_SECTION_ORDER, "notes", "down")
    ).toEqual([...DEFAULT_DASHBOARD_SECTION_ORDER])
  })
})
