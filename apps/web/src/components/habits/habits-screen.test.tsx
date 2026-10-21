import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultPreferences,
  toIsoDate,
  todayInTimeZone,
  uuidV7,
  type SessionContext
} from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import { PreferencesProvider } from "../../lib/preferences"
import { LocalStoreProvider } from "../../lib/local-store"
import { openLocalStore } from "../../lib/local-store/store"
import { cacheSession } from "../../lib/session-cache"
import { createHabitInMirror } from "../../lib/habits/model"
import { HabitsScreen } from "./habits-screen"

/**
 * Ticket #66 exit criteria at the screen seam: a habit is created on the one
 * form without a network round trip, delete is undoable on the same row, and
 * the card's badge/rate come from the mirror.
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

const type = (element: Element, value: string) => {
  fireEvent.input(element, { target: { value } })
  flush()
}

const click = (element: Element) => {
  fireEvent.click(element)
  flush()
}

const eventually = async (assert: () => void): Promise<void> => {
  await waitFor(() => {
    flush()
    assert()
  })
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
  flush()
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <PreferencesProvider>
        <LocalStoreProvider>
          <HabitsScreen />
        </LocalStoreProvider>
      </PreferencesProvider>
    </AuthProvider>
  ))

const today = (): string => toIsoDate(todayInTimeZone(ZONE))

describe("HabitsScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    stubNetwork()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("creates a habit in one form, locally, with the chosen frequency", async () => {
    const screen = mount()
    const input = await screen.findByLabelText("عنوان عادت")
    await eventually(() => expect((input as HTMLInputElement).disabled).toBe(false))

    type(input, "کتاب خواندن")
    type(screen.getByLabelText("توضیح عادت"), "هر شب پیش از خواب")
    fireEvent.input(screen.getByLabelText("زمان یادآوری عادت"), {
      target: { value: "21:30" }
    })
    flush()
    click(screen.getByRole("button", { name: "۳ بار در هفته" }))
    click(screen.getByRole("button", { name: "افزودن عادت" }))

    await eventually(() =>
      expect(screen.getByRole("heading", { name: "کتاب خواندن" })).toBeTruthy()
    )
    await eventually(() =>
      expect(screen.getByLabelText("زنجیره: بدون زنجیره")).toBeTruthy()
    )
    // The weekly unit names its counting period even before it is satisfied.
    await settle()
    expect(screen.getAllByText(/دورهٔ شمارش/).length).toBeGreaterThan(0)

    const store = await openLocalStore(session.user.id)
    try {
      const rows = await store.list("habit")
      expect(rows).toHaveLength(1)
      expect(rows[0]!.data).toMatchObject({
        title: "کتاب خواندن",
        description: "هر شب پیش از خواب",
        reminderTime: "21:30",
        frequency: { _tag: "weekly", times: 3 },
        startedOn: today()
      })
      const pending = await store.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ entityType: "habit", op: "upsert" })
    } finally {
      store.close()
    }

    screen.unmount()
  })

  it("deletes with a confirmation, an undo toast, and restores the same row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const store = await openLocalStore(session.user.id)
    await createHabitInMirror(
      store,
      { title: "پیاده‌روی", frequency: { _tag: "daily" }, timeZone: ZONE },
      new Date().toISOString()
    )
    store.close()

    const screen = mount()
    await eventually(() =>
      expect(screen.getByRole("heading", { name: "پیاده‌روی" })).toBeTruthy()
    )

    click(screen.getByRole("button", { name: "حذف پیاده‌روی" }))
    await eventually(() => expect(screen.getByText(/«پیاده‌روی» حذف شد/)).toBeTruthy())
    await eventually(() =>
      expect(screen.queryByRole("heading", { name: "پیاده‌روی" })).toBeNull()
    )

    click(screen.getByRole("button", { name: "بازگردانی" }))
    await eventually(() =>
      expect(screen.getByRole("heading", { name: "پیاده‌روی" })).toBeTruthy()
    )

    const reopened = await openLocalStore(session.user.id)
    try {
      const live = await reopened.list("habit")
      expect(live).toHaveLength(1)
      expect(live[0]!.data.title).toBe("پیاده‌روی")
    } finally {
      reopened.close()
    }

    screen.unmount()
  })

  it("edits the same habit from that form instead of creating a second one", async () => {
    const store = await openLocalStore(session.user.id)
    await createHabitInMirror(
      store,
      { title: "آب", frequency: { _tag: "daily" }, timeZone: ZONE },
      new Date().toISOString()
    )
    store.close()

    const screen = mount()
    await eventually(() =>
      expect(screen.getByRole("button", { name: "ویرایش آب" })).toBeTruthy()
    )
    click(screen.getByRole("button", { name: "ویرایش آب" }))
    const input = screen.getByLabelText("عنوان عادت") as HTMLInputElement
    expect(input.value).toBe("آب")
    type(input, "آب کافی")
    click(screen.getByRole("button", { name: "ذخیرهٔ عادت" }))

    await eventually(() =>
      expect(screen.getByRole("heading", { name: "آب کافی" })).toBeTruthy()
    )
    const reopened = await openLocalStore(session.user.id)
    try {
      expect(await reopened.list("habit")).toHaveLength(1)
    } finally {
      reopened.close()
    }

    screen.unmount()
  })
})
