import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildMonthReadModel,
  buildWeekReadModel,
  defaultPreferences,
  jalaliMonthOf,
  uuidV7,
  weekRange,
  type CalendarTaskSource,
  type SessionContext,
  type UserPreferences
} from "@tali/domain"
import { AuthProvider } from "../../lib/auth"
import { PreferencesProvider } from "../../lib/preferences"
import { LocalStoreProvider } from "../../lib/local-store"
import { openLocalStore } from "../../lib/local-store/store"
import type { LocalStore } from "../../lib/local-store/types"
import { cacheSession } from "../../lib/session-cache"
import { createTaskInMirror } from "../../lib/tasks/model"
import { createOccasionInMirror } from "../../lib/occasions/model"
import {
  dayLabel,
  monthTitle,
  todayIn
} from "../../lib/calendar/model"
import { CalendarScreen } from "./calendar-screen"

/**
 * Ticket #43 at the client seam: the week/month screen prefers the server read
 * models, falls back to the mirror offline, keeps quick add / planning /
 * completion local-first, marks busy days and opens a day drill-down.
 */

const TIME_ZONE = "UTC"

const newSession = (): SessionContext => ({
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: `calendar-${uuidV7()}@example.com` as SessionContext["user"]["email"],
    displayName: "آزمون",
    timeZone: TIME_ZONE,
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
})

let session: SessionContext = newSession()
let preferences: UserPreferences
let sources: Array<CalendarTaskSource> = []
let plan: { readonly week?: "fail"; readonly month?: "fail" } = {}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  })

const source = (
  input: Partial<CalendarTaskSource> & { readonly id?: string }
): CalendarTaskSource => ({
  id: input.id ?? uuidV7(),
  title: input.title ?? "کار",
  status: input.status ?? "todo",
  priority: input.priority ?? "medium",
  dueDate: input.dueDate ?? null,
  dueAt: input.dueAt ?? null,
  recurrence: input.recurrence ?? null,
  recurrenceMode: input.recurrenceMode ?? null
})

const weekModelFor = (anchor: string) =>
  buildWeekReadModel({ tasks: sources, anchor, weekStart: "saturday", timeZone: TIME_ZONE })

const monthModelFor = (anchor: string, day: string | undefined) => {
  const { year, month } = jalaliMonthOf(anchor)
  return buildMonthReadModel({
    tasks: sources,
    year,
    month,
    weekStart: "saturday",
    timeZone: TIME_ZONE,
    day: day ?? null
  })
}

const stubNetwork = (next: typeof plan = {}): void => {
  plan = next
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/auth/me")) return json(200, session)
    if (url.pathname.endsWith("/preferences")) {
      return json(200, { preferences })
    }
    if (url.pathname.endsWith("/week")) {
      if (plan.week === "fail") throw new TypeError("network down")
      const anchor = url.searchParams.get("anchor") ?? todayIn(TIME_ZONE)
      const model = weekModelFor(anchor)
      const etag = `"week-${anchor}-${sources.length}"`
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.["if-none-match"] === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, model, { etag })
    }
    if (url.pathname.endsWith("/month")) {
      if (plan.month === "fail") throw new TypeError("network down")
      const anchor = url.searchParams.get("anchor") ?? todayIn(TIME_ZONE)
      const day = url.searchParams.get("day") ?? undefined
      const model = monthModelFor(anchor, day)
      const etag = `"month-${anchor}-${day ?? ""}-${sources.length}"`
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.["if-none-match"] === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, model, { etag })
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

const waitForSource = async (
  screen: ReturnType<typeof mountCalendar>,
  source: "server" | "mirror"
): Promise<void> => {
  await eventually(() => {
    expect(
      screen.container.querySelector(`main[data-source="${source}"]`)
    ).toBeTruthy()
  })
}

/**
 * The local store opens asynchronously behind the auth boot, so inline actions
 * stay disabled until it is ready. Interact only after that.
 */
const waitForStore = async (
  screen: ReturnType<typeof mountCalendar>
): Promise<void> => {
  await eventually(() => {
    const input = screen.container.querySelector<HTMLInputElement>(
      ".calendar-quick input"
    )
    expect(input?.disabled).toBe(false)
  })
}

const mountCalendar = () =>
  render(() => (
    <AuthProvider>
      <PreferencesProvider>
        <LocalStoreProvider>
          <CalendarScreen />
        </LocalStoreProvider>
      </PreferencesProvider>
    </AuthProvider>
  ))

const withStore = async (run: (store: LocalStore) => Promise<void>): Promise<void> => {
  const store = await openLocalStore(session.user.id)
  try {
    await run(store)
  } finally {
    store.close()
  }
}

const dayCards = (container: HTMLElement): ReadonlyArray<HTMLElement> =>
  [...container.querySelectorAll<HTMLElement>(".calendar-day-card")]

describe("Calendar week view", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    preferences = defaultPreferences(session.user.id, {
      timeZone: TIME_ZONE,
      weekStart: "saturday",
      digits: "persian"
    })
    sources = []
    stubNetwork()
  })

  it("renders seven days from the server read model", async () => {
    sources = [source({ title: "کار امروز", dueDate: todayIn(TIME_ZONE) })]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(screen.getByText("کار امروز")).toBeTruthy()
    })
    expect(dayCards(screen.container)).toHaveLength(7)
    // Every day has a quick-add field and quiet event/reminder/habit lanes.
    expect(screen.container.querySelectorAll(".calendar-quick")).toHaveLength(7)
    expect(screen.getAllByText("رویداد — خالی")).toHaveLength(7)
    expect(screen.getAllByText("یادآوری — خالی")).toHaveLength(7)
    expect(screen.getAllByText("عادت — خالی")).toHaveLength(7)
    screen.unmount()
  })

  it("quick-adds a task to the chosen day as a local write", async () => {
    const today = todayIn(TIME_ZONE)
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    const card = screen.container.querySelector<HTMLElement>(
      `[aria-label="${dayLabel(today, "persian")}"]`
    )!
    const input = within(card).getByLabelText(
      `کار تازه برای ${dayLabel(today, "persian")}`
    ) as HTMLInputElement
    await waitForStore(screen)

    fireEvent.input(input, { target: { value: "خرید نان" } })
    flush()
    fireEvent.click(within(card).getByRole("button", { name: "افزودن" }))

    await withStore(async (store) => {
      const tasks = await store.list("task")
      expect(tasks.map((task) => task.data.title)).toContain("خرید نان")
      const created = tasks.find((task) => task.data.title === "خرید نان")
      expect(created?.data.dueDate).toBe(today)
    })
    await eventually(() => {
      expect(screen.getByText("خرید نان")).toBeTruthy()
    })
    expect(
      (screen.getByLabelText(`کار تازه برای ${dayLabel(today, "persian")}`) as HTMLInputElement)
        .value
    ).toBe("")
    screen.unmount()
  })

  it("falls back to the mirror when the API is unreachable", async () => {
    await withStore(async (store) => {
      await createTaskInMirror(store, {
        title: "کار آفلاین",
        dueDate: todayIn(TIME_ZONE),
        priority: "medium",
        projectId: null,
        tagIds: [],
        timeZone: TIME_ZONE
      })
      // Let the queue empty, so the screen really attempts the server read and
      // falls back on a network failure rather than holding the optimistic row.
      const queued = await store.pending()
      await store.ack(queued.map((entry) => entry.clientMutationId))
    })
    stubNetwork({ week: "fail", month: "fail" })

    const screen = mountCalendar()
    await waitForSource(screen, "mirror")
    await eventually(() => {
      expect(screen.getByText("کار آفلاین")).toBeTruthy()
      expect(screen.getByText(/آفلاین — نمایش از حافظهٔ محلی/)).toBeTruthy()
    })
    screen.unmount()
  })

  it("returns to the server snapshot after an offline blip", async () => {
    const today = todayIn(TIME_ZONE)
    sources = [source({ title: "کار سرور", dueDate: today })]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("کار سرور")).toBeTruthy())

    const setOnline = (value: boolean) => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value })
      window.dispatchEvent(new Event(value ? "online" : "offline"))
    }

    try {
      // A blip drops the server snapshot (the screen paints the mirror) but
      // must not leave a validator behind: after reconnecting, the API answers
      // 304 for an unchanged body, and a 304 with no snapshot would strand the
      // screen on the mirror forever.
      setOnline(false)
      await waitForSource(screen, "mirror")

      setOnline(true)
      await waitForSource(screen, "server")
      await eventually(() => expect(screen.getByText("کار سرور")).toBeTruthy())
    } finally {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    }
    screen.unmount()
  })

  it("keeps projected recurrence occurrences read-only", async () => {
    const series = source({
      title: "ورزش",
      dueDate: shiftFrom(todayIn(TIME_ZONE), -7),
      recurrence: {
        frequency: "weekly",
        interval: 1,
        byDay: [isoWeekdayOf(todayIn(TIME_ZONE))],
        end: { _tag: "never" }
      },
      recurrenceMode: "onDueDate"
    })
    sources = [series]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(screen.getByText("ورزش")).toBeTruthy()
    })
    expect(screen.getAllByText("تکرارشونده — فقط نمایش").length).toBeGreaterThan(0)
    expect(
      screen.queryByRole("checkbox", { name: "انجام ورزش" })
    ).toBeNull()
    screen.unmount()
  })

  it("reviews and prioritises the week without leaving the grid", async () => {
    const today = todayIn(TIME_ZONE)
    const weekStart = weekRange(today, "saturday").start
    const id = uuidV7()
    sources = [source({ id, title: "کار هفته", dueDate: weekStart })]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("کار هفته")).toBeTruthy())

    const toggle = screen.getByRole("button", { name: "برنامه‌ریزی هفته" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    await eventually(() => {
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      expect(screen.getByRole("region", { name: "برنامه‌ریزی هفته" })).toBeTruthy()
    })

    const priority = screen.getByLabelText("اولویت کار هفته") as HTMLSelectElement
    await eventually(() => expect(priority.disabled).toBe(false))
    expect(priority.value).toBe("medium")
    fireEvent.change(priority, { target: { value: "high" } })
    await withStore(async (store) => {
      await eventually(async () => {
        expect(store.closed).toBe(false)
        expect((await store.get("task", id))?.data.priority).toBe("high")
      })
    })

    fireEvent.click(screen.getByRole("button", { name: "یک روز بعد کار هفته" }))
    await withStore(async (store) => {
      await eventually(async () => {
        expect((await store.get("task", id))?.data.dueDate).toBe(shiftFrom(weekStart, 1))
      })
    })
    screen.unmount()
  })

  it("completes a real task locally", async () => {
    const today = todayIn(TIME_ZONE)
    const id = uuidV7()
    sources = [source({ id, title: "خرید نان", dueDate: today })]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("خرید نان")).toBeTruthy())

    await waitForStore(screen)
    fireEvent.click(screen.getByRole("checkbox", { name: "انجام خرید نان" }))
    await eventually(() => expect(screen.queryByText("خرید نان")).toBeNull())
    await withStore(async (store) => {
      expect((await store.get("task", id))?.data.status).toBe("done")
    })
    screen.unmount()
  })
})

describe("Calendar month view", () => {
  beforeEach(() => {
    localStorage.clear()
    session = newSession()
    cacheSession(session)
    preferences = defaultPreferences(session.user.id, {
      timeZone: TIME_ZONE,
      weekStart: "saturday",
      digits: "persian"
    })
    sources = []
    stubNetwork()
  })

  it("marks busy days and opens the day drill-down", async () => {
    const today = todayIn(TIME_ZONE)
    const first = uuidV7()
    const second = uuidV7()
    sources = [
      source({ id: first, title: "کار اول", dueDate: today }),
      source({ id: second, title: "کار دوم", dueDate: today, priority: "high" })
    ]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("کار اول")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(
        screen.getByRole("list", { name: monthTitle(today, "persian") })
      ).toBeTruthy()
    })

    const dayButton = screen.getByRole("button", {
      name: `${dayLabel(today, "persian")} — ۲ کار`
    })
    expect(dayButton.querySelectorAll(".calendar-month-dot")).toHaveLength(1)

    fireEvent.click(dayButton)
    await waitForSource(screen, "server")
    await eventually(() => {
      const detail = screen.getByRole("region", { name: "جزئیات روز" })
      expect(within(detail).getByText("کار اول")).toBeTruthy()
      expect(within(detail).getByText("کار دوم")).toBeTruthy()
      expect(
        screen
          .getByRole("button", {
            name: `${dayLabel(today, "persian")} — ۲ کار`
          })
          .getAttribute("aria-pressed")
      ).toBe("true")
    })

    // The trend strip is reserved, quiet, and named for Slice 4.
    expect(screen.getByRole("region", { name: "روند عادت‌ها" })).toBeTruthy()
    screen.unmount()
  })

  it("quick-adds from the drill-down and keeps it in the month", async () => {
    const today = todayIn(TIME_ZONE)
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(dayCards(screen.container)).toHaveLength(7))

    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(
        screen.getByRole("list", { name: monthTitle(today, "persian") })
      ).toBeTruthy()
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: `${dayLabel(today, "persian")} — ۰ کار`
      })
    )
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(screen.getByRole("region", { name: "جزئیات روز" })).toBeTruthy()
    })

    const detail = screen.getByRole("region", { name: "جزئیات روز" })
    await waitForStore(screen)
    const input = within(detail).getByLabelText(
      `کار تازه برای ${dayLabel(today, "persian")}`
    ) as HTMLInputElement
    fireEvent.input(input, { target: { value: "از نمای ماه" } })
    flush()
    fireEvent.click(within(detail).getByRole("button", { name: "افزودن" }))

    await eventually(() => {
      expect(screen.getByText("از نمای ماه")).toBeTruthy()
    })
    await withStore(async (store) => {
      const tasks = await store.list("task")
      expect(tasks.some((task) => task.data.title === "از نمای ماه")).toBe(true)
    })
    screen.unmount()
  })

  it("paints the annual occasion and prepares its task in one tap", async () => {
    const today = todayIn(TIME_ZONE)
    let occasionId = ""
    await withStore(async (store) => {
      occasionId = await createOccasionInMirror(store, {
        title: "تولد مامان",
        originDate: today,
        timeZone: TIME_ZONE,
        yearly: true,
        advanceReminderDays: 7
      })
    })

    const screen = mountCalendar()
    await waitForSource(screen, "server")
    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "server")
    await eventually(() => {
      const prepare = screen.getByRole("button", { name: "آماده‌سازی تولد مامان" })
      expect(prepare.hasAttribute("disabled")).toBe(false)
    })

    await eventually(() => {
      const chip = screen.container.querySelector(".calendar-occasion-chip")
      expect(chip?.textContent).toBe("تولد مامان")
    })

    // Jalali and Gregorian share one line in the panel.
    await eventually(() => {
      expect(screen.container.querySelector("[data-occasion-id]")?.textContent).toContain("·")
    })

    fireEvent.click(screen.getByRole("button", { name: "آماده‌سازی تولد مامان" }))

    await withStore(async (store) => {
      await eventually(async () => {
        const tasks = await store.list("task")
        const prepared = tasks.find(
          (task) => task.data.title === "آماده‌سازی برای تولد مامان"
        )
        expect(prepared).toBeTruthy()
        expect(prepared?.data.dueDate).toBe(shiftFrom(today, -7))
        const occasion = await store.get("occasion", occasionId)
        expect(occasion?.data.preparationTaskId).toBe(prepared?.entityId)
      })
    })

    await eventually(() => {
      expect(
        screen.getByText("کار آماده‌سازی برای «تولد مامان» ساخته شد")
      ).toBeTruthy()
    })
    screen.unmount()
  })

  it("moves from a month day into the week view", async () => {
    const today = todayIn(TIME_ZONE)
    sources = [source({ title: "کار امروز", dueDate: today })]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("کار امروز")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(
        screen.getByRole("button", {
          name: `${dayLabel(today, "persian")} — ۱ کار`
        })
      ).toBeTruthy()
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: `${dayLabel(today, "persian")} — ۱ کار`
      })
    )
    await waitForSource(screen, "server")
    await eventually(() => {
      expect(screen.getByRole("region", { name: "جزئیات روز" })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "دیدن در نمای هفته" }))
    await eventually(() => {
      expect(dayCards(screen.container)).toHaveLength(7)
      expect(screen.getByRole("button", { name: "هفته" }).getAttribute("aria-pressed")).toBe(
        "true"
      )
    })
    screen.unmount()
  })
})

/** Local helpers keep the fixtures readable without a second date library. */
const shiftFrom = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const isoWeekdayOf = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}
