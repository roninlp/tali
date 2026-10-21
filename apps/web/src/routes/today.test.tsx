import "fake-indexeddb/auto"
import { createEffect, flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createRouter } from "@solidjs/router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DASHBOARD_SECTIONS,
  defaultPreferences,
  taskBucketBounds,
  uuidV7,
  type SessionContext,
  type UserPreferences
} from "@tali/domain"
import { AuthProvider } from "../lib/auth"
import { PreferencesProvider } from "../lib/preferences"
import { LocalStoreProvider, useLocalStore } from "../lib/local-store"
import { openLocalStore } from "../lib/local-store/store"
import type { LocalStore } from "../lib/local-store/types"
import { readCachedPreferences } from "../lib/preferences-cache"
import { cacheSession } from "../lib/session-cache"
import { createTaskInMirror } from "../lib/tasks/model"
import TodayRoute from "./today"

/**
 * Ticket #42 at the client seam: the dashboard prefers the `GET /today` read
 * model, falls back to mirror aggregation when the API is unreachable, renders
 * the #35 section order, and keeps every inline action local-first.
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

let session: SessionContext = newSession()
let preferences: UserPreferences

const bounds = (): ReturnType<typeof taskBucketBounds> =>
  taskBucketBounds("UTC", new Date().toISOString())

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  })

interface TaskFixture {
  readonly id: string
  readonly title: string
}

const taskFixture = (title: string): TaskFixture & Record<string, unknown> => {
  const now = new Date().toISOString()
  return {
    id: uuidV7(),
    title,
    type: "task",
    description: null,
    ownerId: session.user.id,
    householdId: session.householdId!,
    visibility: "shared",
    color: null,
    status: "todo",
    priority: "medium",
    dueAt: null,
    dueDate: bounds().today,
    timeZone: "UTC",
    projectId: null,
    tagIds: [],
    recurrence: null,
    recurrenceMode: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    deletedAt: null
  }
}

const noteFixture = (title: string) => {
  const now = new Date().toISOString()
  return {
    id: uuidV7(),
    title,
    type: "note",
    body: null,
    plainText: "متن یادداشت",
    ownerId: session.user.id,
    householdId: session.householdId!,
    visibility: "shared",
    color: null,
    isPinned: true,
    isArchived: false,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
    deletedAt: null
  }
}

interface ReadModelFixture {
  readonly today: string
  readonly tomorrow: string
  readonly timeZone: string
  readonly sectionOrder: ReadonlyArray<string>
  readonly tasks: ReadonlyArray<unknown>
  readonly notes: ReadonlyArray<unknown>
  readonly counts: Record<string, number>
  readonly empty: Record<string, boolean>
}

const readModel = (input: {
  tasks?: ReadonlyArray<unknown>
  notes?: ReadonlyArray<unknown>
} = {}): ReadModelFixture => {
  const tasks = input.tasks ?? []
  const notes = input.notes ?? []
  return {
    today: bounds().today,
    tomorrow: bounds().tomorrow,
    timeZone: "UTC",
    sectionOrder: ["tasks", "events", "reminders", "habits", "notes"],
    tasks,
    notes,
    counts: {
      tasks: tasks.length,
      overdue: 0,
      events: 0,
      reminders: 0,
      habits: 0,
      notes: notes.length
    },
    empty: {
      tasks: tasks.length === 0,
      events: true,
      reminders: true,
      habits: true,
      notes: notes.length === 0
    }
  }
}

interface NetworkPlan {
  readonly today?: ReadModelFixture | "fail"
  readonly etag?: string
  readonly sectionOrder?: ReadonlyArray<string>
}

let plan: NetworkPlan
let preferencePatches: Array<Record<string, unknown>> = []

const stubNetwork = (next: NetworkPlan): void => {
  plan = next
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/auth/me")) return json(200, session)
    if (url.endsWith("/preferences")) {
      const method = init?.method ?? "GET"
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        preferencePatches.push(body)
        preferences = { ...preferences, ...body } as UserPreferences
      }
      return json(200, {
        preferences: {
          ...preferences,
          dashboardSectionOrder:
            plan.sectionOrder ?? preferences.dashboardSectionOrder
        }
      })
    }
    if (url.endsWith("/today")) {
      if (plan.today === "fail" || plan.today === undefined) {
        throw new TypeError("network down")
      }
      const etag = plan.etag ?? '"today-v1"'
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.["if-none-match"] === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, plan.today, { etag, "cache-control": "private, no-cache" })
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
          <StoreProbe />
          <Router>{(props) => props.children}</Router>
        </LocalStoreProvider>
      </PreferencesProvider>
    </AuthProvider>
  ))
}

/**
 * The provider's own store instance. An IndexedDB connection opened elsewhere
 * does not notify it, so tests that must simulate an outbox drain have to ack
 * through the same store the screen is subscribed to.
 */
let providerStore: LocalStore | undefined

function StoreProbe() {
  const local = useLocalStore()
  createEffect(
    () => local.store(),
    (store) => {
      providerStore = store
    }
  )
  return null
}

const withStore = async (run: (store: LocalStore) => Promise<void>): Promise<void> => {
  const store = await openLocalStore(session.user.id)
  try {
    await run(store)
  } finally {
    store.close()
  }
}

const seedOfflineTask = async (
  title: string,
  dueDate: string | null
): Promise<string> => {
  let id = ""
  await withStore(async (store) => {
    id = await createTaskInMirror(store, {
      title,
      dueDate,
      priority: "medium",
      projectId: null,
      tagIds: [],
      timeZone: "UTC"
    })
  })
  return id
}

const seedPinnedNote = async (title: string): Promise<string> => {
  const id = uuidV7()
  const now = new Date().toISOString()
  await withStore(async (store) => {
    await store.writeLocal({
      entityType: "note",
      entityId: id,
      op: "upsert",
      patch: {
        id,
        type: "note",
        title,
        body: null,
        plainText: "متن یادداشت",
        isPinned: true,
        isArchived: false,
        tagIds: [],
        visibility: "shared",
        createdAt: now
      },
      now
    })
  })
  return id
}

const sectionsInOrder = (container: HTMLElement): ReadonlyArray<string> =>
  [...container.querySelectorAll("[data-section]")].map(
    (section) => section.getAttribute("data-section") ?? ""
  )

/** Open the reorder panel from its header toggle before clicking its buttons. */
const openOrderControl = async (
  screen: ReturnType<typeof mountToday>
): Promise<void> => {
  const toggle = screen.getByRole("button", { name: "ترتیب بخش‌ها" })
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(toggle)
  await eventually(() => {
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByRole("region", { name: "ترتیب بخش‌ها" })).toBeTruthy()
  })
}

const clickMove = async (
  screen: ReturnType<typeof mountToday>,
  name: string,
  expectedPatches: number
): Promise<void> => {
  fireEvent.click(screen.getByRole("button", { name }))
  await eventually(() => {
    expect(preferencePatches.length).toBe(expectedPatches)
    // The PATCH is recorded before its promise resolves; wait for the control
    // to leave its saving state so the next click is not ignored.
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })
}

describe("Today dashboard", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    preferences = defaultPreferences(session.user.id, {
      timeZone: "UTC",
      weekStart: "saturday",
      digits: "persian"
    })
    preferencePatches = []
    stubNetwork({})
  })

  it("renders the server read model in the saved section order", async () => {
    const task = taskFixture("کار سرور")
    const note = noteFixture("یادداشت سرور")
    stubNetwork({
      today: readModel({ tasks: [task], notes: [note] }),
      sectionOrder: ["notes", "tasks", "events", "reminders", "habits"]
    })

    const screen = mountToday()
    await eventually(() => {
      expect(screen.getByText("کار سرور")).toBeTruthy()
      expect(screen.getByText("یادداشت سرور")).toBeTruthy()
      expect(sectionsInOrder(screen.container)).toEqual([
        "notes",
        "tasks",
        "events",
        "reminders",
        "habits"
      ])
    })
    screen.unmount()
  })

  it("falls back to mirror aggregation when the API is unreachable", async () => {
    await seedOfflineTask("کار آفلاین", bounds().today)
    await seedOfflineTask("کار فردا", bounds().tomorrow)
    await seedPinnedNote("یادداشت آفلاین")
    // Simulate rows that have already synced: the fallback path is about the
    // API being unreachable, not about an outbox that is still draining.
    await withStore(async (store) => {
      const queued = await store.pending()
      await store.ack(queued.map((entry) => entry.clientMutationId))
    })
    stubNetwork({ today: "fail" })

    const screen = mountToday()
    await eventually(() => {
      expect(screen.getByText("کار آفلاین")).toBeTruthy()
      expect(screen.getByText("یادداشت آفلاین")).toBeTruthy()
      expect(screen.queryByText("کار فردا")).toBeNull()
      expect(screen.getByText(/آفلاین — نمایش از حافظهٔ محلی/)).toBeTruthy()
    })
    screen.unmount()
  })

  it("completes, moves to tomorrow, and opens rows without leaving Today", async () => {
    const first = taskFixture("خرید نان")
    const second = taskFixture("تماس با مادر")
    const note = noteFixture("ایده‌های هفته")
    stubNetwork({ today: readModel({ tasks: [first, second], notes: [note] }) })

    const screen = mountToday()
    await eventually(() => {
      expect(screen.getByText("خرید نان")).toBeTruthy()
      const input = screen.getByLabelText("کار تازه برای امروز") as HTMLInputElement
      expect(input.disabled).toBe(false)
    })

    expect(
      screen.getByRole("link", { name: "تماس با مادر" }).getAttribute("href")
    ).toBe(`/tasks#task-${second.id}`)
    expect(
      screen.getByRole("link", { name: "باز کردن ایده‌های هفته" }).getAttribute("href")
    ).toBe(`/notes/${note.id}`)

    fireEvent.click(screen.getByRole("checkbox", { name: "انجام خرید نان" }))
    await eventually(() => expect(screen.queryByText("خرید نان")).toBeNull())
    await withStore(async (store) => {
      const row = await store.get("task", first.id)
      expect(row?.data.status).toBe("done")
      // The action is durable: it is queued for the server, not just painted.
      const queued = await store.pending()
      expect(
        queued.some(
          (entry) => entry.entityType === "task" && entry.entityId === first.id
        )
      ).toBe(true)
    })

    fireEvent.click(screen.getByRole("button", { name: "فردا کردن تماس با مادر" }))
    await eventually(() => expect(screen.queryByText("تماس با مادر")).toBeNull())
    await withStore(async (store) => {
      const row = await store.get("task", second.id)
      expect(row?.data.dueDate).toBe(bounds().tomorrow)
      const queued = await store.pending()
      expect(
        queued.some(
          (entry) => entry.entityType === "task" && entry.entityId === second.id
        )
      ).toBe(true)
    })

    screen.unmount()
  })

  it("keeps an optimistic write on screen after the outbox acks a stale read model", async () => {
    const task = taskFixture("خرید نان")
    stubNetwork({ today: readModel({ tasks: [task] }) })

    const screen = mountToday()
    await eventually(() => {
      expect(screen.getByText("خرید نان")).toBeTruthy()
      const input = screen.getByLabelText("کار تازه برای امروز") as HTMLInputElement
      expect(input.disabled).toBe(false)
    })

    fireEvent.click(screen.getByRole("checkbox", { name: "انجام خرید نان" }))
    await eventually(() => expect(screen.queryByText("خرید نان")).toBeNull())

    // The outbox drains before the read model does. `/today` still answers with
    // the pre-write payload (a 304 for the ETag we already hold), so without
    // the local-write overlay the completed row would flash back on screen.
    const store = providerStore
    expect(store).toBeTruthy()
    const queued = await store!.pending()
    expect(queued.length).toBeGreaterThan(0)
    await store!.ack(queued.map((entry) => entry.clientMutationId))
    expect(await store!.pending()).toEqual([])

    await eventually(() => expect(screen.queryByText("خرید نان")).toBeNull())
    // Give the post-drain revalidation a chance to resolve and re-render.
    await new Promise((resolve) => setTimeout(resolve, 50))
    flush()
    expect(screen.queryByText("خرید نان")).toBeNull()

    screen.unmount()
  })

  it("quick-adds a task due today as a local write", async () => {
    stubNetwork({ today: readModel() })

    const screen = mountToday()
    await eventually(() => {
      const field = screen.getByLabelText("کار تازه برای امروز") as HTMLInputElement
      expect(field.disabled).toBe(false)
    })
    const input = screen.getByLabelText("کار تازه برای امروز") as HTMLInputElement

    fireEvent.input(input, { target: { value: "آب خوردن" } })
    flush()
    fireEvent.click(screen.getByRole("button", { name: "افزودن" }))

    await eventually(() => expect(screen.getByText("آب خوردن")).toBeTruthy())
    await withStore(async (store) => {
      const tasks = await store.list("task")
      const created = tasks.find((task) => task.data.title === "آب خوردن")
      expect(created).toBeTruthy()
      expect(created?.data.dueDate).toBe(bounds().today)
    })
    expect((input as HTMLInputElement).value).toBe("")
    screen.unmount()
  })

  it("reorders a section from the control, persists the full permutation, and re-renders live", async () => {
    stubNetwork({ today: readModel() })

    const screen = mountToday()
    await eventually(() => {
      expect(sectionsInOrder(screen.container)).toEqual([...DASHBOARD_SECTIONS])
    })

    await openOrderControl(screen)
    await clickMove(screen, "انتقال یادداشت‌های پین‌شده به بالا", 1)

    const expected = ["tasks", "events", "reminders", "notes", "habits"]
    await eventually(() => {
      expect(sectionsInOrder(screen.container)).toEqual(expected)
    })
    expect(preferencePatches.at(-1)).toEqual({ dashboardSectionOrder: expected })
    // The same PATCH response updates the cache, so the order survives a
    // reload/offline boot rather than only living in this render.
    expect(readCachedPreferences(session.user.id)?.dashboardSectionOrder).toEqual(
      expected
    )
    screen.unmount()
  })

  it("only produces full, unique permutations and disables impossible moves", async () => {
    stubNetwork({ today: readModel() })

    const screen = mountToday()
    await eventually(() => {
      expect(sectionsInOrder(screen.container)).toEqual([...DASHBOARD_SECTIONS])
    })

    await openOrderControl(screen)
    expect(
      (screen.getByRole("button", {
        name: "انتقال کارهای امروز به بالا"
      }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole("button", {
        name: "انتقال یادداشت‌های پین‌شده به پایین"
      }) as HTMLButtonElement).disabled
    ).toBe(true)

    await clickMove(screen, "انتقال یادداشت‌های پین‌شده به بالا", 1)
    await clickMove(screen, "انتقال یادداشت‌های پین‌شده به بالا", 2)
    await clickMove(screen, "انتقال یادداشت‌های پین‌شده به پایین", 3)

    expect(preferencePatches).toHaveLength(3)
    for (const patch of preferencePatches) {
      const order = patch.dashboardSectionOrder as ReadonlyArray<string>
      expect(order).toHaveLength(DASHBOARD_SECTIONS.length)
      expect(new Set(order).size).toBe(DASHBOARD_SECTIONS.length)
      expect([...order].sort()).toEqual([...DASHBOARD_SECTIONS].sort())
    }
    // The last persisted order is exactly what `/today` is rendering.
    const last = preferencePatches.at(-1)!.dashboardSectionOrder as ReadonlyArray<string>
    await eventually(() => {
      expect(sectionsInOrder(screen.container)).toEqual(last)
    })
    screen.unmount()
  })

  it("shows a meaningful empty state with a suggested first action", async () => {
    stubNetwork({ today: readModel() })

    const screen = mountToday()
    await eventually(() => {
      expect(screen.getByText(/امروز خالی است/)).toBeTruthy()
      expect(screen.getByRole("button", { name: /افزودن اولین کار/ })).toBeTruthy()
      expect(screen.getByText(/یادداشتی پین نشده است/)).toBeTruthy()
    })
    screen.unmount()
  })
})
