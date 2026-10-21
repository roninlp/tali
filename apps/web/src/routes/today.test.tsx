import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { render, waitFor } from "@solidjs/testing-library"
import { createRouter } from "@solidjs/router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultPreferences, uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../lib/auth"
import { PreferencesProvider } from "../lib/preferences"
import { LocalStoreProvider } from "../lib/local-store"
import { openLocalStore } from "../lib/local-store/store"
import { cacheSession } from "../lib/session-cache"
import { createListItemInMirror, createListInMirror } from "../lib/lists/mirror"
import TodayRoute from "./today"

/**
 * The dashboard quick list owns the legacy scaffold rows only. Ticket #39 puts
 * every `/lists` item in the same mirror table, so without the `listId` scope
 * the whole shopping list would appear on Today.
 */

const newSession = (): SessionContext => ({
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: `user-${uuidV7()}@example.com` as SessionContext["user"]["email"],
    displayName: "آزمون",
    timeZone: "UTC",
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
})

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

let session: SessionContext = newSession()

const stubNetwork = (): void => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/auth/me")) return json(200, session)
    if (url.endsWith("/preferences")) {
      return json(200, {
        preferences: defaultPreferences(session.user.id, {
          timeZone: "UTC",
          weekStart: "saturday",
          digits: "persian"
        })
      })
    }
    throw new Error(`unexpected network call: ${url}`)
  }) as unknown as typeof fetch
}

const eventually = async (assert: () => void): Promise<void> => {
  await waitFor(() => {
    flush()
    assert()
  })
}

const mountToday = () => {
  window.history.pushState({}, "", "/today")
  const Router = createRouter({
    routes: [{ path: "/today", component: TodayRoute }]
  })
  return render(() => (
    <AuthProvider>
      <PreferencesProvider>
        <LocalStoreProvider>
          <Router>{(props) => props.children}</Router>
        </LocalStoreProvider>
      </PreferencesProvider>
    </AuthProvider>
  ))
}

describe("Today quick list", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    stubNetwork()
  })

  it("shows scaffold quick items and hides items that belong to a list", async () => {
    const now = new Date().toISOString()
    const store = await openLocalStore(session.user.id)
    try {
      const quickId = uuidV7()
      await store.writeLocal({
        entityType: "listItem",
        entityId: quickId,
        op: "upsert",
        patch: { id: quickId, title: "کار خانه", checked: false, sortOrder: 0, createdAt: now },
        now
      })
      const listId = await createListInMirror(store, { title: "خرید" })
      await createListItemInMirror(store, listId, { name: "شیر", order: 1 })
    } finally {
      store.close()
    }

    const screen = mountToday()
    await eventually(() => expect(screen.getByText("کار خانه")).toBeTruthy())
    expect(screen.queryByText("شیر")).toBeNull()
    screen.unmount()
  })
})
