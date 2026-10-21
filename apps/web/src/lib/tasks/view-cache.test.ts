import { describe, expect, it } from "vitest"
import {
  DEFAULT_TASK_VIEW,
  cacheTaskViewSettings,
  parseTaskViewSettings,
  readTaskViewSettings
} from "./view-cache"

/** The filter bar persists per user and degrades to defaults on bad data. */

describe("task view persistence", () => {
  it("round-trips filters and sort through localStorage", () => {
    const view = {
      filters: {
        projectId: "11111111-1111-7111-8111-111111111111",
        tagIds: ["22222222-2222-7222-8222-222222222222"],
        priority: "high" as const,
        status: "doing" as const,
        date: "week" as const
      },
      sort: { by: "title" as const, direction: "desc" as const }
    }
    cacheTaskViewSettings("user-1", view)
    expect(readTaskViewSettings("user-1")).toEqual(view)
  })

  it("falls back to defaults for corrupt or unknown values", () => {
    expect(parseTaskViewSettings("nope")).toBeUndefined()
    expect(
      parseTaskViewSettings(
        JSON.stringify({
          filters: { projectId: 7, tagIds: ["a", 3], priority: "urgent", status: "?", date: "soon" },
          sort: { by: "sideways", direction: "up" }
        })
      )
    ).toEqual({
      filters: { projectId: undefined, tagIds: ["a"], priority: "all", status: "all", date: "all" },
      sort: { by: "dueDate", direction: "asc" }
    })
  })

  it("keeps the no-project filter distinct from all projects", () => {
    expect(parseTaskViewSettings(JSON.stringify({ filters: { projectId: null } }))?.filters.projectId).toBeNull()
    expect(DEFAULT_TASK_VIEW.filters.projectId).toBeUndefined()
  })
})
