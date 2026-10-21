import { describe, expect, it } from "vitest"
import {
  DASHBOARD_SECTIONS,
  DEFAULT_DASHBOARD_SECTION_ORDER,
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
