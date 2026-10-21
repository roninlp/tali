import { beforeEach, describe, expect, it } from "vitest"
import { defaultPreferences, type UserId, type UserPreferences } from "@tali/domain"
import {
  cachePreferences,
  clearCachedPreferences,
  readCachedPreferences
} from "./preferences-cache"

const USER_A = "0192f0a0-0000-7000-8000-00000000000a" as UserId
const USER_B = "0192f0a0-0000-7000-8000-00000000000b" as UserId

const preferencesFor = (userId: UserId, overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  ...defaultPreferences(userId),
  ...overrides
})

describe("preferences cache", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the last server-confirmed preferences per user", () => {
    const saved = preferencesFor(USER_A, {
      timeZone: "Europe/Berlin",
      weekStart: "monday",
      digits: "latin",
      dashboardSectionOrder: ["notes", "tasks", "events", "reminders", "habits"],
      checkedItemPlacement: "inPlace"
    })

    cachePreferences(saved)
    expect(readCachedPreferences(USER_A)).toEqual(saved)
  })

  it("keeps two users on one browser isolated", () => {
    cachePreferences(preferencesFor(USER_A, { weekStart: "monday", digits: "latin" }))
    cachePreferences(preferencesFor(USER_B, { weekStart: "sunday" }))

    expect(readCachedPreferences(USER_A)?.weekStart).toBe("monday")
    expect(readCachedPreferences(USER_B)?.weekStart).toBe("sunday")
    expect(readCachedPreferences(USER_B)?.digits).toBe("persian")
  })

  it("ignores malformed, foreign or impossible cached shapes", () => {
    localStorage.setItem(`tali.preferences.v1.${USER_A}`, "{not json")
    expect(readCachedPreferences(USER_A)).toBeUndefined()

    localStorage.setItem(
      `tali.preferences.v1.${USER_A}`,
      JSON.stringify({ userId: USER_A, weekStart: "tuesday" })
    )
    expect(readCachedPreferences(USER_A)).toBeUndefined()

    expect(readCachedPreferences(USER_B)).toBeUndefined()
  })

  it("clears one user without touching the other", () => {
    cachePreferences(preferencesFor(USER_A))
    cachePreferences(preferencesFor(USER_B))

    clearCachedPreferences(USER_A)
    expect(readCachedPreferences(USER_A)).toBeUndefined()
    expect(readCachedPreferences(USER_B)).toBeDefined()
  })
})
