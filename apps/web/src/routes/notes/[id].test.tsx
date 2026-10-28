import "fake-indexeddb/auto"
import { render, fireEvent, waitFor } from "@solidjs/testing-library"
import { createRouter } from "@solidjs/router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import {
  LocalStoreProvider,
  useLocalStore,
  type LocalStore,
  type LocalStoreContextValue
} from "../../lib/local-store"
import { openLocalStore } from "../../lib/local-store/store"
import NoteEditorRoute from "./[id]"

/**
 * The store subscription is the only handle on "a notification arrived", and
 * the editor owns its callback. Record every listener an opened store gets so
 * a test can deliver a burst in one tick, the way several commits would.
 */
const storeListeners = new Set<() => void>()

vi.mock("../../lib/local-store/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/local-store/store")>()
  return {
    ...actual,
    openLocalStore: async (
      userId: string,
      options?: Parameters<typeof actual.openLocalStore>[1]
    ): Promise<LocalStore> => {
      const store = await actual.openLocalStore(userId, options)
      return Object.create(store, {
        subscribe: {
          value: (listener: () => void) => {
            storeListeners.add(listener)
            return store.subscribe(listener)
          }
        }
      }) as LocalStore
    }
  }
})

const session: SessionContext = {
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: "owner@example.com" as SessionContext["user"]["email"],
    displayName: "مالک",
    timeZone: "Asia/Tehran",
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
}

const stubServer = (): void => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(session), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch
}

let local: LocalStoreContextValue | undefined

function StoreProbe() {
  local = useLocalStore()
  return null
}

const mount = (id: string) => {
  window.history.pushState({}, "", `/notes/${id}`)
  const Router = createRouter({
    routes: [{ path: "/notes/:id", component: NoteEditorRoute }]
  })
  return render(() => (
    <AuthProvider>
      <LocalStoreProvider>
        <StoreProbe />
        <Router>{(props) => props.children}</Router>
      </LocalStoreProvider>
    </AuthProvider>
  ))
}

/** A server-known note whose latest local push was refused. */
const seedFailedNote = async (): Promise<{
  readonly id: string
  readonly clientMutationId: string
}> => {
  const store = await openLocalStore(session.user.id)
  const id = uuidV7()
  const clientMutationId = uuidV7()
  try {
    await store.mergeServer([
      {
        entityType: "note",
        entityId: id,
        version: 4,
        updatedAt: "2026-10-20T09:30:00.000Z",
        deletedAt: null,
        data: {
          id,
          type: "note",
          title: "خرید دارو",
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "متن قدیمی" }] }]
          },
          plainText: "متن قدیمی",
          isPinned: false,
          isArchived: false,
          tagIds: [],
          visibility: "shared",
          createdAt: "2026-10-20T09:30:00.000Z"
        }
      }
    ])
    await store.ack([], [], [
      {
        entityType: "note",
        entityId: id,
        code: "InvalidPatch",
        message: 'The patch value for "title" is not valid',
        at: "2026-10-20T09:31:00.000Z",
        clientMutationId
      }
    ])
  } finally {
    store.close()
  }
  return { id, clientMutationId }
}

/** A server-known note with no queued mutation. */
const seedNote = async (): Promise<string> => {
  const store = await openLocalStore(session.user.id)
  const id = uuidV7()
  try {
    await store.mergeServer([
      {
        entityType: "note",
        entityId: id,
        version: 1,
        updatedAt: "2026-10-20T09:30:00.000Z",
        deletedAt: null,
        data: {
          id,
          type: "note",
          title: "یادداشت",
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "متن" }] }]
          },
          plainText: "متن",
          isPinned: false,
          isArchived: false,
          tagIds: [],
          visibility: "shared",
          createdAt: "2026-10-20T09:30:00.000Z"
        }
      }
    ])
  } finally {
    store.close()
  }
  return id
}

describe("note editor sync failure", () => {
  beforeEach(() => {
    localStorage.clear()
    storeListeners.clear()
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    stubServer()
  })

  it("shows the failure banner and retries as one fresh queued upsert", async () => {
    const { id, clientMutationId } = await seedFailedNote()
    const view = mount(id)
    await waitFor(() => expect(local!.status()).toBe("ready"))

    const banner = await view.findByRole("alert")
    expect(banner.textContent).toContain("معتبر ندانست")
    // The banner explains the failure in Persian, never with a raw code.
    expect(banner.textContent).not.toContain("InvalidPatch")
    expect(view.getByText("ذخیره نشد؛ روی سرور اعمال نشد")).toBeTruthy()

    fireEvent.click(view.getByRole("button", { name: "تلاش دوباره" }))

    const store = local!.store()!
    await waitFor(async () => expect(await store.pending()).toHaveLength(1))
    const [queued] = await store.pending()
    expect(queued!.clientMutationId).not.toBe(clientMutationId)
    expect(queued).toMatchObject({
      entityType: "note",
      entityId: id,
      op: "upsert",
      baseVersion: 4,
      patch: { title: "خرید دارو", plainText: "متن قدیمی" }
    })
    expect((await store.get("note", id))!.syncError).toBeUndefined()
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull())
    view.unmount()
  })

  it("reads the note once per store notification", async () => {
    const id = await seedNote()
    const view = mount(id)
    await waitFor(() => expect(local!.status()).toBe("ready"))
    await view.findByLabelText("متن یادداشت")

    const store = local!.store()!
    const originalGet = store.get.bind(store)
    let noteReads = 0
    const get = vi.spyOn(store, "get").mockImplementation((entityType, entityId) => {
      if (entityType === "note" && entityId === id) noteReads += 1
      return originalGet(entityType, entityId)
    })

    // An unrelated write still notifies this editor; both facts it needs (the
    // draft anchor and the rejection marker) must come from one row read.
    await store.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "نامرتبط" }
    })

    await waitFor(() => expect(noteReads).toBe(1))
    // Nothing else should have scheduled a second read in the same window.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(noteReads).toBe(1)

    get.mockRestore()
    view.unmount()
  })

  it("collapses several notifications in one tick into one read", async () => {
    const id = await seedNote()
    const view = mount(id)
    await waitFor(() => expect(local!.status()).toBe("ready"))
    await view.findByLabelText("متن یادداشت")
    // The provider and the editor each subscribe once the store is open.
    await waitFor(() => expect(storeListeners.size).toBeGreaterThanOrEqual(2))

    const store = local!.store()!
    const originalGet = store.get.bind(store)
    let noteReads = 0
    const get = vi.spyOn(store, "get").mockImplementation((entityType, entityId) => {
      if (entityType === "note" && entityId === id) noteReads += 1
      return originalGet(entityType, entityId)
    })

    // Five notifications before the coalescer's microtask runs (what a burst
    // of commits in one tick looks like at the subscriber boundary).
    for (let index = 0; index < 5; index += 1) {
      for (const listener of storeListeners) listener()
    }

    await waitFor(() => expect(noteReads).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(noteReads).toBe(1)

    get.mockRestore()
    view.unmount()
  })
})
