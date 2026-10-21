import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createRouter } from "@solidjs/router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultPreferences,
  uuidV7,
  type SessionContext
} from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import { PreferencesProvider } from "../../lib/preferences"
import { LocalStoreProvider } from "../../lib/local-store"
import * as storeModule from "../../lib/local-store/store"
import { cacheSession } from "../../lib/session-cache"
import {
  createListItemInMirror,
  createListInMirror
} from "../../lib/lists/mirror"
import { toListItemRow } from "../../lib/lists/model"
import { ListDetailScreen } from "./list-detail"

/**
 * Ticket #39 screen seam: five Enters stay in the same input, checking shows
 * the undo toast, checked-at-bottom grouping follows the list preference, and
 * the other member's edit surfaces the subtle "updated by" label. IndexedDB is
 * fake-indexeddb; the network is stubbed to the auth/preferences bootstrap.
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

const type = (element: Element, value: string) => {
  fireEvent.input(element, { target: { value } })
  flush()
}

const click = (element: Element) => {
  fireEvent.click(element)
  flush()
}

const submit = (form: Element) => {
  fireEvent.submit(form)
  flush()
}

const eventually = async (assert: () => void): Promise<void> => {
  await waitFor(() => {
    flush()
    assert()
  })
}

const mount = (listId: string) => {
  window.history.pushState({}, "", `/lists/${listId}`)
  const Router = createRouter({
    routes: [{ path: "/lists/:id", component: ListDetailScreen }]
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

const seedList = async (title = "خرید"): Promise<string> => {
  const store = await storeModule.openLocalStore(session.user.id)
  try {
    return await createListInMirror(store, { title, checkedPlacement: "bottom" })
  } finally {
    store.close()
  }
}

const addItem = async (listId: string, name: string, order: number): Promise<string> => {
  const store = await storeModule.openLocalStore(session.user.id)
  try {
    return await createListItemInMirror(store, listId, { name, order })
  } finally {
    store.close()
  }
}

const mirrorItems = async (listId: string) => {
  const store = await storeModule.openLocalStore(session.user.id)
  try {
    return (await store.list("listItem"))
      .map(toListItemRow)
      .filter((item) => item.listId === listId)
  } finally {
    store.close()
  }
}

/**
 * Real IndexedDB resolves a read in a later task; fake-indexeddb resolves it in
 * the same tick, which lets Solid coalesce "loading" and "ready" into one
 * render and hide remount bugs. This wraps the store the provider opens with a
 * small delay so a reload spans a painted frame, exactly like a browser.
 */
const slowMirror = (options: { readonly readMs?: number; readonly writeMs?: number } = {}) => {
  const readMs = options.readMs ?? 20
  const writeMs = options.writeMs ?? 0
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const original = storeModule.openLocalStore
  vi.spyOn(storeModule, "openLocalStore").mockImplementation(async (userId) => {
    const store = await original(userId)
      const wrapped = {
      ...store,
      get closed() {
        return store.closed
      },
      get: async (entityType: never, entityId: string) => {
        await pause(readMs)
        const row = await store.get(entityType, entityId)
        flush()
        return row
      },
      list: async (entityType: never) => {
        await pause(readMs)
        const rows = await store.list(entityType)
        flush()
        return rows
      },
      pending: async () => {
        await pause(readMs)
        return store.pending()
      },
      writeLocal: async (write: Parameters<typeof store.writeLocal>[0]) => {
        await pause(writeMs)
        const result = await store.writeLocal(write)
        flush()
        return result
      }
    }
    return wrapped as unknown as typeof store
  })
}

describe("ListDetailScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    stubNetwork()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("adds five items without leaving the input", async () => {
    const listId = await seedList()
    const screen = mount(listId)

    const input = (await screen.findByLabelText("نام مورد تازه")) as HTMLInputElement
    await eventually(() => expect(input.disabled).toBe(false))

    const names = ["نان", "شیر", "تخم‌مرغ", "پنیر", "سبزی"]
    for (const [index, name] of names.entries()) {
      type(input, name)
      submit(input.closest("form")!)
      await eventually(() => expect(input.value).toBe(""))
      await eventually(() => expect(document.activeElement).toBe(input))
      if (index < names.length - 1) {
        await eventually(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0))
      }
    }

    await eventually(() => {
      expect(screen.getAllByText("نان").length).toBeGreaterThan(0)
      expect(screen.getAllByText("سبزی").length).toBeGreaterThan(0)
    })
    expect(
      (await mirrorItems(listId))
        .sort((a, b) => a.order - b.order)
        .map((item) => item.name)
    ).toEqual(names)
    screen.unmount()
  })

  it("checks with an undo toast and groups checked rows at the bottom", async () => {
    const listId = await seedList("کارها")
    await addItem(listId, "ظرف‌ها", 1)
    const screen = mount(listId)

    const check = await screen.findByRole("checkbox", { name: "تیک زدن ظرف‌ها" })
    click(check)
    await eventually(() => expect(screen.getByText("تیک خورد: ظرف‌ها")).toBeTruthy())
    await waitFor(async () => {
      const item = (await mirrorItems(listId))[0]!
      expect(item.done).toBe(true)
      expect(item.checkedAt).not.toBeNull()
    })

    click(screen.getByRole("button", { name: "بازگرداندن" }))
    await waitFor(async () => {
      const item = (await mirrorItems(listId))[0]!
      expect(item.done).toBe(false)
      expect(item.checkedAt).toBeNull()
    })

    // Checked-at-bottom: a checked row stays after an open row.
    await eventually(() =>
      expect(screen.getByRole("checkbox", { name: "تیک زدن ظرف‌ها" })).toBeTruthy()
    )
    click(screen.getByRole("checkbox", { name: "تیک زدن ظرف‌ها" }))
    await eventually(() =>
      expect(screen.getByRole("checkbox", { name: "برداشتن تیک ظرف‌ها" })).toBeTruthy()
    )
    const input = screen.getByLabelText("نام مورد تازه") as HTMLInputElement
    type(input, "الف")
    submit(input.closest("form")!)
    await eventually(() => {
      const rows = screen.container.querySelectorAll(".lists-item")
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain("الف")
      expect(rows[1]!.textContent).toContain("ظرف‌ها")
    })
    screen.unmount()
  })

  it("shows the updated-by label for the other member's edit", async () => {
    const listId = await seedList("مشترک")
    const store = await storeModule.openLocalStore(session.user.id)
    try {
      // The server's pull would hydrate this acknowledged row; seed it with
      // version 3 and the other member as the last writer.
      await store.mergeServer([
        {
          entityType: "listItem",
          entityId: uuidV7(),
          version: 3,
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          data: {
            listId,
            name: "شیر",
            done: false,
            order: 1,
            lastWriterId: "spouse"
          }
        }
      ])
    } finally {
      store.close()
    }

    const screen = mount(listId)
    await eventually(() =>
      expect(screen.getAllByText("توسط همخانه به‌روزرسانی شد").length).toBeGreaterThan(0)
    )
    screen.unmount()
  })

  it("keeps the entry field focused and the draft intact while a row is written", async () => {
    const listId = await seedList()
    await addItem(listId, "ظرف‌ها", 1)

    const screen = mount(listId)
    const input = (await screen.findByLabelText("نام مورد تازه")) as HTMLInputElement
    await eventually(() => expect(input.isConnected).toBe(true))

    type(input, "شیر نیمه‌کاره")
    input.focus()
    expect(document.activeElement).toBe(input)

    click(screen.getByRole("checkbox", { name: "تیک زدن ظرف‌ها" }))
    await eventually(() =>
      expect(screen.getByRole("checkbox", { name: "برداشتن تیک ظرف‌ها" })).toBeTruthy()
    )

    // Checking a row reloads the mirror; the composer must not be disturbed.
    expect(screen.getByLabelText("نام مورد تازه")).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("شیر نیمه‌کاره")
    screen.unmount()
  })

  it("does not remount an unchanged row when another row is checked", async () => {
    const listId = await seedList()
    await addItem(listId, "نان", 1)
    await addItem(listId, "ظرف‌ها", 2)
    slowMirror({ readMs: 20 })

    const screen = mount(listId)
    const untouched = (await screen.findByRole("checkbox", {
      name: "تیک زدن نان"
    })) as HTMLButtonElement
    await eventually(() =>
      expect(screen.getByRole("checkbox", { name: "تیک زدن ظرف‌ها" })).toBeTruthy()
    )

    click(screen.getByRole("checkbox", { name: "تیک زدن ظرف‌ها" }))
    await eventually(() =>
      expect(screen.getByRole("checkbox", { name: "برداشتن تیک ظرف‌ها" })).toBeTruthy()
    )
    // Same DOM node: the re-render updated attributes instead of remounting.
    expect(screen.getByRole("checkbox", { name: "تیک زدن نان" })).toBe(untouched)
    screen.unmount()
  })

  it("keeps the next item typed while the previous write is still in flight", async () => {
    const listId = await seedList()
    slowMirror({ readMs: 10, writeMs: 60 })

    const screen = mount(listId)
    const input = (await screen.findByLabelText("نام مورد تازه")) as HTMLInputElement
    await eventually(() => expect(input.isConnected).toBe(true))

    type(input, "نان")
    submit(input.closest("form")!)
    // Continuous entry: the user is already on the next line while the first
    // mirror transaction settles.
    type(input, "شیر")

    // Only after the first write has settled and its row is on screen is the
    // pending draft meaningful.
    await eventually(() => expect(screen.getAllByText("نان").length).toBeGreaterThan(0))
    expect(input.value).toBe("شیر")
    expect(
      (await mirrorItems(listId)).map((item) => item.name)
    ).toEqual(["نان"])
    screen.unmount()
  })
})
