import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultPreferences,
  todayInTimeZone,
  toIsoDate,
  uuidV7,
  type SessionContext
} from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import { PreferencesProvider } from "../../lib/preferences"
import { LocalStoreProvider } from "../../lib/local-store"
import { openLocalStore } from "../../lib/local-store/store"
import { cacheSession } from "../../lib/session-cache"
import { createTaskInMirror, shiftLocalDate, toTaskRow } from "../../lib/tasks/model"
import { TasksScreen } from "./tasks-screen"

/**
 * Ticket #37 exit criteria at the screen seam, with IndexedDB (fake-indexeddb)
 * and a stubbed network: quick-add writes locally before anything syncs, the
 * board renders from the mirror offline, moves change the day in one action,
 * and complete/undo (toast and history) round-trips through the outbox.
 *
 * Solid 2 batches reactive writes until the next flush, and the testing
 * library's `fireEvent` re-export does not flush for us — `type`/`click` do,
 * and `eventually` flushes while polling for a write that settles later.
 */

const ZONE = "UTC"

const newSession = (): SessionContext => ({
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: `user-${uuidV7()}@example.com` as SessionContext["user"]["email"],
    displayName: "آزمون",
    timeZone: ZONE,
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
          timeZone: ZONE,
          weekStart: "saturday",
          digits: "persian"
        })
      })
    }
    throw new Error(`unexpected network call: ${url}`)
  }) as unknown as typeof fetch
}

const seed = async (
  rows: ReadonlyArray<Parameters<typeof createTaskInMirror>[1]>
): Promise<void> => {
  const store = await openLocalStore(session.user.id)
  try {
    for (const draft of rows) await createTaskInMirror(store, draft, new Date().toISOString())
  } finally {
    store.close()
  }
}

const type = (element: Element, value: string) => {
  fireEvent.input(element, { target: { value } })
  flush()
}

const change = (element: Element, value: string) => {
  fireEvent.change(element, { target: { value } })
  flush()
}

const click = (element: Element) => {
  fireEvent.click(element)
  flush()
}

/** Poll an assertion while letting queued Solid updates apply. */
const eventually = async (assert: () => void): Promise<void> => {
  await waitFor(() => {
    flush()
    assert()
  })
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <PreferencesProvider>
        <LocalStoreProvider>
          <TasksScreen />
        </LocalStoreProvider>
      </PreferencesProvider>
    </AuthProvider>
  ))

const today = (): string => toIsoDate(todayInTimeZone(ZONE))

const mirrorTask = async (title: string) => {
  const store = await openLocalStore(session.user.id)
  try {
    const rows = await store.list("task")
    const record = rows.find((row) => row.data.title === title)
    return record === undefined ? undefined : toTaskRow(record)
  } finally {
    store.close()
  }
}

const draft = (
  title: string,
  dueDate: string | null,
  priority: "high" | "medium" | "low" = "medium"
): Parameters<typeof createTaskInMirror>[1] => ({
  title,
  dueDate,
  priority,
  projectId: null,
  tagIds: [],
  timeZone: ZONE
})

describe("TasksScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    stubNetwork()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })

  it("quick-adds locally: the card and a pending outbox entry appear without RPC", async () => {
    const screen = mount()
    const input = await screen.findByLabelText("عنوان کار تازه")
    await eventually(() => expect((input as HTMLInputElement).disabled).toBe(false))

    type(input, "خرید شیر")
    click(screen.getByRole("button", { name: "افزودن" }))

    await eventually(() => expect(screen.getByRole("button", { name: "خرید شیر" })).toBeTruthy())
    await eventually(() => expect(screen.getByText("در صف")).toBeTruthy())

    const store = await openLocalStore(session.user.id)
    try {
      const pending = await store.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        entityType: "task",
        op: "upsert",
        patch: { title: "خرید شیر", dueDate: today(), priority: "medium" }
      })
      const row = toTaskRow((await store.get("task", pending[0]!.entityId))!)
      expect(row.title).toBe("خرید شیر")
      expect(row.status).toBe("todo")
    } finally {
      store.close()
    }

    screen.unmount()
  })

  it("completes with an undo toast and restores from the completion history", async () => {
    await seed([draft("نان", today())])
    const screen = mount()

    await eventually(() =>
      expect(screen.getByRole("button", { name: "انجام دادن: نان" })).toBeTruthy()
    )
    click(screen.getByRole("button", { name: "انجام دادن: نان" }))

    await eventually(() => expect(screen.getByText("انجام شد: نان")).toBeTruthy())
    await waitFor(async () => expect((await mirrorTask("نان"))?.status).toBe("done"))

    // Undo from the toast.
    click(screen.getByRole("button", { name: "بازگرداندن" }))
    await eventually(() =>
      expect(screen.getByRole("button", { name: "انجام دادن: نان" })).toBeTruthy()
    )
    await waitFor(async () => {
      const row = await mirrorTask("نان")
      expect(row?.status).toBe("todo")
      expect(row?.completedAt).toBeNull()
    })

    // Complete again, then restore from the seven-day history.
    await eventually(() =>
      expect(screen.getByRole("button", { name: "انجام دادن: نان" })).toBeTruthy()
    )
    click(screen.getByRole("button", { name: "انجام دادن: نان" }))
    await waitFor(async () => expect((await mirrorTask("نان"))?.status).toBe("done"))
    await eventually(() =>
      expect(screen.getByRole("button", { name: "بازگرداندن نان" })).toBeTruthy()
    )
    click(screen.getByRole("button", { name: "بازگرداندن نان" }))

    await eventually(() =>
      expect(screen.getByRole("button", { name: "انجام دادن: نان" })).toBeTruthy()
    )
    await waitFor(async () => expect((await mirrorTask("نان"))?.status).toBe("todo"))

    screen.unmount()
  })

  it("moves a task to tomorrow in one action", async () => {
    await seed([draft("بی‌تاریخ", null)])
    const screen = mount()

    await eventually(() =>
      expect(screen.getByRole("button", { name: "بی‌تاریخ" })).toBeTruthy()
    )
    const moves = screen.getByRole("group", { name: "جابه‌جایی بی‌تاریخ" })
    click(within(moves).getByRole("button", { name: "فردا" }))

    await waitFor(async () => {
      expect((await mirrorTask("بی‌تاریخ"))?.dueDate).toBe(shiftLocalDate(today(), 1))
    })
    await eventually(() => {
      const upcoming = screen.getByRole("region", { name: "پیش‌رو" })
      expect(within(upcoming).getByRole("button", { name: "بی‌تاریخ" })).toBeTruthy()
    })

    screen.unmount()
  })

  it("renders the week from the mirror while offline", async () => {
    await seed([
      draft("کار عقب", shiftLocalDate(today(), -1)),
      draft("کار امروز", today()),
      draft("کار هفتهٔ بعد", shiftLocalDate(today(), 7)),
      draft("کار صندوق", null)
    ])
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    cacheSession(session)
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline")
    }) as unknown as typeof fetch

    const screen = mount()
    await eventually(() =>
      expect(screen.getByRole("button", { name: "کار امروز" })).toBeTruthy()
    )
    expect(screen.getByText(/آفلاین هستید/)).toBeTruthy()

    // The offline board still groups overdue above today, and the inbox is separate.
    const todayBoard = screen.getByRole("region", { name: "امروز" })
    expect(within(todayBoard).getByText("از قبل مانده")).toBeTruthy()
    expect(within(todayBoard).getByRole("button", { name: "کار عقب" })).toBeTruthy()
    expect(within(todayBoard).getByRole("button", { name: "کار امروز" })).toBeTruthy()
    const inbox = screen.getByRole("region", { name: "بدون تاریخ" })
    expect(within(inbox).getByRole("button", { name: "کار صندوق" })).toBeTruthy()
    const upcoming = screen.getByRole("region", { name: "پیش‌رو" })
    expect(within(upcoming).getByRole("button", { name: "کار هفتهٔ بعد" })).toBeTruthy()

    screen.unmount()
  })

  it("filters and sorts from the persistent bar, with counts", async () => {
    await seed([draft("کار مهم", today(), "high"), draft("کار کم", today(), "low")])
    const screen = mount()

    await eventually(() =>
      expect(screen.getByRole("button", { name: "کار مهم" })).toBeTruthy()
    )
    click(screen.getByRole("button", { name: "فیلترها و پروژه‌ها" }))

    const priority = screen.getByLabelText("اولویت") as HTMLSelectElement
    change(priority, "high")

    await eventually(() =>
      expect(screen.queryByRole("button", { name: "کار کم" })).toBeNull()
    )
    expect(screen.getByRole("button", { name: "کار مهم" })).toBeTruthy()
    expect(screen.getByText(/۱ کار/)).toBeTruthy()

    // The picked filter is persisted for the next visit (same user, new mount).
    const stored = localStorage.getItem(`tali.tasks.view.v1.${session.user.id}`)
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!).filters.priority).toBe("high")

    screen.unmount()
  })

  it("autosaves an edit with a saving → saved indicator", async () => {
    await seed([draft("نان", today())])
    const screen = mount()

    await eventually(() => expect(screen.getByRole("button", { name: "نان" })).toBeTruthy())
    click(screen.getByRole("button", { name: "نان" }))
    const titleInput = (await screen.findByLabelText("عنوان")) as HTMLInputElement
    type(titleInput, "نان سنگک")

    await eventually(() => expect(screen.getByText("در حال ذخیره…")).toBeTruthy())
    await eventually(() => expect(screen.getByText("ذخیره شد")).toBeTruthy())
    await eventually(() =>
      expect(screen.getByRole("button", { name: "نان سنگک" })).toBeTruthy()
    )

    await waitFor(async () => {
      const store = await openLocalStore(session.user.id)
      try {
        const rows = await store.list("task")
        expect(rows.some((row) => row.data.title === "نان سنگک")).toBe(true)
      } finally {
        store.close()
      }
    })

    screen.unmount()
  })
})
