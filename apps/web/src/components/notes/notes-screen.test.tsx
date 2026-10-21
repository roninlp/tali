import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createRouter } from "@solidjs/router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultPreferences,
  uuidV7,
  type SessionContext,
  type UserPreferences
} from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import { PreferencesProvider } from "../../lib/preferences"
import { LocalStoreProvider } from "../../lib/local-store"
import { openLocalStore } from "../../lib/local-store/store"
import { cacheSession } from "../../lib/session-cache"
import { NotesScreen } from "./notes-screen"

/**
 * Ticket #41 at the client seam: the search box.
 *
 * Two paths are pinned here:
 *
 * 1. the server's index answers the query and the match is rendered marked;
 * 2. with the network gone, the local mirror answers it instead — the same
 *    notes, found by the same variant-insensitive match.
 */

const TIME_ZONE = "UTC"

const newSession = (): SessionContext => ({
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: `notes-search-${uuidV7()}@example.com` as SessionContext["user"]["email"],
    displayName: "آزمون",
    timeZone: TIME_ZONE,
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
})

let session: SessionContext = newSession()
let preferences: UserPreferences
let plan: { readonly search?: "fail" } = {}
let searchQueries: Array<string> = []

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const stubNetwork = (): void => {
  searchQueries = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/auth/me")) return json(200, session)
    if (url.pathname.endsWith("/preferences")) return json(200, { preferences })
    if (url.pathname.endsWith("/search/notes")) {
      const query = url.searchParams.get("q") ?? ""
      searchQueries.push(query)
      if (plan.search === "fail") throw new TypeError("network down")
      return json(200, {
        query,
        hits: [
          {
            id: uuidV7(),
            title: "خرید دارو",
            segments: [
              { text: "قرص ", match: false },
              { text: "میروم", match: true },
              { text: " و دارو میخورم", match: false }
            ],
            updatedAt: "2026-10-20T09:30:00.000Z"
          }
        ]
      })
    }
    throw new Error(`unexpected network call: ${url.pathname}`)
  }) as unknown as typeof fetch
}

const eventually = async (assert: () => void | Promise<void>): Promise<void> => {
  await waitFor(async () => {
    flush()
    await assert()
  })
}

const mount = () => {
  window.history.pushState({}, "", "/notes")
  const Router = createRouter({
    routes: [{ path: "/notes", component: NotesScreen }]
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

/** Put a note into the mirror, the way the editor writes it. */
const seedNote = async (text: string): Promise<string> => {
  const store = await openLocalStore(session.user.id)
  try {
    const id = uuidV7()
    await store.writeLocal({
      entityType: "note",
      entityId: id,
      op: "upsert",
      patch: {
        id,
        type: "note",
        title: "خرید دارو",
        body: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }]
        },
        plainText: text,
        isPinned: false,
        isArchived: false,
        tagIds: [],
        visibility: "shared",
        createdAt: "2026-10-20T09:30:00.000Z"
      }
    })
    return id
  } finally {
    store.close()
  }
}

describe("notes search", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    preferences = defaultPreferences(session.user.id, {
      timeZone: TIME_ZONE,
      weekStart: "saturday",
      digits: "persian"
    })
    plan = {}
    stubNetwork()
  })

  it("asks the server and renders the match marked", async () => {
    const screen = mount()
    const el = screen.container.querySelector("input")!
    const label = screen.container.querySelector("label") as HTMLLabelElement
    console.log("DEBUG labels:", (el as HTMLInputElement).labels?.length, "id:", el.id, "type:", el.type)
    console.log("DEBUG same control:", label.control === el, "control id:", label.control?.id)
    console.log("DEBUG count:", screen.container.querySelectorAll('[id="note-search"]').length)
    console.log("DEBUG label text:", JSON.stringify(label.textContent))
    const input = await screen.findByLabelText("جست‌وجو در یادداشت‌ها (Ctrl+K)")

    fireEvent.input(input, { target: { value: "میروم" } })

    await eventually(() => {
      expect(searchQueries).toContain("میروم")
      expect(screen.getByText("خرید دارو")).toBeTruthy()
    })

    const marks = screen.container.querySelectorAll("mark")
    expect(marks.length).toBeGreaterThan(0)
    expect([...marks].map((mark) => mark.textContent).join("")).toContain("میروم")

    screen.unmount()
  })

  it("falls back to the local mirror when the network is gone", async () => {
    await seedNote("قرص می‌روم و دارو می‌خورم")
    plan = { search: "fail" }

    const screen = mount()
    const input = await screen.findByLabelText("جست‌وجو در یادداشت‌ها (Ctrl+K)")

    // The query is written with the half-space; the note holds it too, and the
    // offline matcher is variant-insensitive.
    fireEvent.input(input, { target: { value: "میروم" } })

    await eventually(() => {
      expect(
        screen.container.textContent?.includes("جست‌وجو روی همین دستگاه انجام شد")
      ).toBe(true)
      console.log("DEBUG HTML:", screen.container.innerHTML.slice(-3000))
    const marks = screen.container.querySelectorAll("mark")
      expect(marks.length).toBeGreaterThan(0)
    })

    screen.unmount()
  })

  it("clears the query and shows the list again", async () => {
    const screen = mount()
    const input = await screen.findByLabelText("جست‌وجو در یادداشت‌ها (Ctrl+K)")

    fireEvent.input(input, { target: { value: "میروم" } })
    await eventually(() => expect(screen.getByText("نتیجه‌ها")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "پاک کردن" }))
    await eventually(() => expect(screen.queryByText("نتیجه‌ها")).toBeNull())

    screen.unmount()
  })
})
