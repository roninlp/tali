import { beforeEach, describe, expect, it } from "vitest"
import type { SessionContext } from "@tali/domain"
import { cacheSession, clearCachedSession, readCachedSession } from "./session-cache"

const session: SessionContext = {
  user: {
    id: "0192f0a0-0000-7000-8000-000000000001" as SessionContext["user"]["id"],
    email: "owner@example.com" as SessionContext["user"]["email"],
    displayName: "مالک",
    timeZone: "Asia/Tehran",
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: "0192f0a0-0000-7000-8000-000000000002" as NonNullable<SessionContext["householdId"]>
}

describe("session cache", () => {
  beforeEach(() => {
    clearCachedSession()
  })

  it("round-trips the public session context", () => {
    cacheSession(session)
    expect(readCachedSession()).toEqual(session)
  })

  it("returns undefined for malformed or foreign shapes", () => {
    localStorage.setItem("tali.session.v1", "{not json")
    expect(readCachedSession()).toBeUndefined()

    localStorage.setItem("tali.session.v1", JSON.stringify({ user: { id: "x" } }))
    expect(readCachedSession()).toBeUndefined()
  })

  it("clears on demand", () => {
    cacheSession(session)
    clearCachedSession()
    expect(readCachedSession()).toBeUndefined()
  })
})
