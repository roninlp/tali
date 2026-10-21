import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  addJalaliMonths,
  buildMonthReadModel,
  buildWeekReadModel,
  defaultPreferences,
  jalaliMonthOf,
  localizeDigits,
  toIsoDate,
  toJalaliDate,
  uuidV7,
  weekRange,
  type CalendarEventSource,
  type CalendarOccasionSource,
  type CalendarTaskSource,
  type LocalDate,
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
let eventSources: Array<CalendarEventSource> = []
let occasionSources: Array<CalendarOccasionSource> = []
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
  buildWeekReadModel({
    tasks: sources,
    events: eventSources,
    occasions: occasionSources,
    anchor,
    weekStart: "saturday",
    timeZone: TIME_ZONE
  })

const monthModelFor = (anchor: string, day: string | undefined) => {
  const { year, month } = jalaliMonthOf(anchor)
  return buildMonthReadModel({
    tasks: sources,
    events: eventSources,
    occasions: occasionSources,
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
      const etag = `"week-${anchor}-${sources.length}-${eventSources.length}-${occasionSources.length}"`
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
      const etag = `"month-${anchor}-${day ?? ""}-${sources.length}-${eventSources.length}-${occasionSources.length}"`
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.["if-none-match"] === etag) {
        return new Response(null, { status: 304, headers: { etag } })
      }
      return json(200, model, { etag })
    }
    throw new Error(`unexpected network call: ${url.pathname}`)
  }) as unknown as typeof fetch
}

/** The browser's connectivity flag is what the store's `online()` reads. */
const setOnline = (value: boolean): void => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value })
  window.dispatchEvent(new Event(value ? "online" : "offline"))
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
    eventSources = []
    occasionSources = []
    setOnline(true)
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
    // Every day has a quick-add field, an event disclosure and quiet lanes.
    expect(screen.container.querySelectorAll(".calendar-quick")).toHaveLength(7)
    expect(screen.container.querySelectorAll(".calendar-event-add")).toHaveLength(7)
    expect(screen.getAllByText("رویداد زمانی — خالی")).toHaveLength(7)
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
    eventSources = []
    occasionSources = []
    setOnline(true)
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

describe("Calendar event and occasion lanes (#62)", () => {
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
    eventSources = []
    occasionSources = []
    setOnline(true)
    stubNetwork()
  })

  const allDayEvent = (
    input: Partial<CalendarEventSource> & { readonly id: string; readonly date: string }
  ): CalendarEventSource => ({
    title: input.title ?? "رویداد",
    description: null,
    location: null,
    category: null,
    color: null,
    people: [],
    timing: { _tag: "allDay", date: input.date as LocalDate },
    timeZone: TIME_ZONE,
    recurrence: input.recurrence ?? null,
    exceptions: input.exceptions ?? [],
    id: input.id
  })

  const timedEvent = (
    input: Partial<CalendarEventSource> & {
      readonly id: string
      readonly start: string
      readonly end: string
    }
  ): CalendarEventSource => ({
    title: input.title ?? "جلسه",
    description: null,
    location: null,
    category: null,
    color: null,
    people: [],
    timing: { _tag: "timed", start: input.start, end: input.end },
    timeZone: TIME_ZONE,
    recurrence: input.recurrence ?? null,
    exceptions: input.exceptions ?? [],
    id: input.id
  })

  const occasion = (
    input: Partial<CalendarOccasionSource> & { readonly id: string; readonly originDate: string }
  ): CalendarOccasionSource => ({
    title: input.title ?? "سالگرد",
    color: input.color ?? null,
    originDate: input.originDate,
    timeZone: TIME_ZONE,
    yearly: input.yearly ?? true,
    advanceReminderDays: input.advanceReminderDays ?? null,
    id: input.id
  })

  const dayCard = (container: HTMLElement, date: string): HTMLElement =>
    container.querySelector<HTMLElement>(`[aria-label="${dayLabel(date, "persian")}"]`)!

  it("spans all-day events across the cell and puts timed events on the grid", async () => {
    const today = todayIn(TIME_ZONE)
    eventSources = [
      allDayEvent({ id: uuidV7(), date: today, title: "سفر" }),
      timedEvent({
        id: uuidV7(),
        title: "جلسه",
        start: `${today}T09:00:00.000Z`,
        end: `${today}T10:00:00.000Z`
      })
    ]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    const card = dayCard(screen.container, today)

    await eventually(() => {
      const chip = card.querySelector(".calendar-event-chip[data-allday='true']")
      expect(chip?.textContent).toBe("سفر")
      expect(card.querySelector(".calendar-time-grid")).toBeTruthy()
      const block = card.querySelector(".calendar-time-event")
      expect(block?.textContent).toContain("جلسه")
      expect(block?.getAttribute("aria-label")).toBe("۰۹:۰۰ جلسه")
      expect(within(card).queryByText("این روز خالی است.")).toBeNull()
    })
    screen.unmount()
  })

  it("creates an all-day event from a day cell and paints it there", async () => {
    const today = todayIn(TIME_ZONE)
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await waitForStore(screen)
    const card = dayCard(screen.container, today)

    const input = within(card).getByLabelText(
      `عنوان رویداد برای ${dayLabel(today, "persian")}`
    ) as HTMLInputElement
    fireEvent.input(input, { target: { value: "مهمانی" } })
    flush()
    fireEvent.click(within(card).getByRole("button", { name: "افزودن رویداد" }))

    await eventually(() => {
      // The grid is re-projected after the local write, so re-query the card.
      expect(within(dayCard(screen.container, today)).getByText("مهمانی")).toBeTruthy()
      // The server snapshot is still the source; the write is overlaid on it.
      expect(screen.container.querySelector('main[data-source="server"]')).toBeTruthy()
    })
    await withStore(async (store) => {
      const events = await store.list("event")
      const created = events.find((entry) => entry.data.title === "مهمانی")
      expect(created?.data.timing).toEqual({ _tag: "allDay", date: today })
      expect(created?.data.timeZone).toBe(TIME_ZONE)
    })
    screen.unmount()
  })

  it("creates a timed event and shows it on the time grid", async () => {
    const today = todayIn(TIME_ZONE)
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await waitForStore(screen)
    const card = dayCard(screen.container, today)

    fireEvent.input(within(card).getByLabelText(`عنوان رویداد برای ${dayLabel(today, "persian")}`), {
      target: { value: "کلاس" }
    })
    flush()
    fireEvent.click(within(card).getByLabelText("تمام روز"))
    await eventually(() => {
      expect(within(card).getByLabelText(`ساعت شروع رویداد در ${dayLabel(today, "persian")}`)).toBeTruthy()
    })
    fireEvent.input(within(card).getByLabelText(`ساعت شروع رویداد در ${dayLabel(today, "persian")}`), {
      target: { value: "09:00" }
    })
    fireEvent.input(within(card).getByLabelText(`ساعت پایان رویداد در ${dayLabel(today, "persian")}`), {
      target: { value: "10:30" }
    })
    flush()
    fireEvent.click(within(card).getByRole("button", { name: "افزودن رویداد" }))

    await eventually(() => {
      const block = dayCard(screen.container, today).querySelector(".calendar-time-event")
      expect(block?.textContent).toContain("کلاس")
      expect(block?.getAttribute("aria-label")).toContain("۰۹:۰۰")
    })
    await withStore(async (store) => {
      const created = (await store.list("event")).find((entry) => entry.data.title === "کلاس")
      expect((created?.data.timing as { _tag: string } | undefined)?._tag).toBe("timed")
    })
    screen.unmount()
  })

  it("counts events and occasions in the month marks and the drill-down", async () => {
    const today = todayIn(TIME_ZONE)
    eventSources = [allDayEvent({ id: uuidV7(), date: today, title: "سفر" })]
    occasionSources = [
      occasion({ id: uuidV7(), originDate: today, title: "سالگرد", color: "#9f1239" })
    ]
    const screen = mountCalendar()
    await waitForSource(screen, "server")
    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "server")

    const label = `${dayLabel(today, "persian")} — ۰ کار — ۱ رویداد — ۱ مناسبت`
    await eventually(() => {
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    })
    const dayButton = screen.getByRole("button", { name: label })
    expect(dayButton.querySelectorAll(".calendar-month-dot")).toHaveLength(1)
    expect(dayButton.querySelector(".calendar-event-chip")?.textContent).toBe("سفر")

    fireEvent.click(dayButton)
    await eventually(() => {
      const detail = screen.getByRole("region", { name: "جزئیات روز" })
      expect(within(detail).getByText("سفر")).toBeTruthy()
      expect(within(detail).getByText("سالگرد")).toBeTruthy()
      expect(detail.querySelector(".calendar-event-row")?.textContent).toContain("تمام روز")
      // The occasion carries both calendars.
      expect(detail.querySelector(".calendar-occasion-date")?.textContent).toContain("·")
    })
    screen.unmount()
  })

  it("paints an occasion chip on the week's annual date", async () => {
    const today = todayIn(TIME_ZONE)
    occasionSources = [
      occasion({ id: uuidV7(), originDate: today, title: "سالگرد هفته" })
    ]
    const screen = mountCalendar()
    await waitForSource(screen, "server")

    const card = dayCard(screen.container, today)
    await eventually(() => {
      const chip = card.querySelector(".calendar-occasion-chip-week")
      expect(chip?.textContent).toBe("سالگرد هفته")
      expect(chip?.getAttribute("aria-label")).toContain("·")
      expect(screen.getByText(/مناسبت در این هفته/).textContent).toContain(
        localizeDigits(1, "persian")
      )
    })
    screen.unmount()
  })

  it("paints an annual occasion on this year's Jalali date", async () => {
    const today = todayIn(TIME_ZONE)
    // The same Jalali month/day three years earlier: a different Gregorian day.
    const origin = toIsoDate(addJalaliMonths(toJalaliDate(today), -36))
    expect(origin).not.toBe(today)
    await withStore(async (store) => {
      await createOccasionInMirror(store, {
        title: "تولد",
        originDate: origin,
        timeZone: TIME_ZONE,
        yearly: true,
        advanceReminderDays: 7
      })
    })
    stubNetwork({ month: "fail" })

    const screen = mountCalendar()
    fireEvent.click(screen.getByRole("button", { name: "ماه" }))
    await waitForSource(screen, "mirror")
    await eventually(() => {
      const dayButton = screen.getByRole("button", {
        name: `${dayLabel(today, "persian")} — ۰ کار — ۱ مناسبت`
      })
      expect(dayButton.querySelector(".calendar-occasion-chip")?.textContent).toBe("تولد")
    })
    screen.unmount()
  })

  it("renders a local event while the API is unreachable", async () => {
    const today = todayIn(TIME_ZONE)
    await withStore(async (store) => {
      const id = uuidV7()
      await store.writeLocal({
        entityType: "event",
        entityId: id,
        op: "upsert",
        patch: {
          id,
          type: "event",
          title: "آفلاین",
          description: null,
          location: null,
          category: null,
          people: [],
          timing: { _tag: "allDay", date: today },
          timeZone: TIME_ZONE,
          recurrence: null,
          exceptions: [],
          occasionId: null,
          color: null,
          visibility: "shared",
          createdAt: new Date().toISOString()
        }
      })
      const queued = await store.pending()
      await store.ack(queued.map((entry) => entry.clientMutationId))
    })
    stubNetwork({ week: "fail", month: "fail" })

    const screen = mountCalendar()
    await waitForSource(screen, "mirror")
    await eventually(() => {
      expect(
        dayCard(screen.container, today).querySelector(".calendar-event-chip")?.textContent
      ).toBe("آفلاین")
      expect(screen.getByText(/آفلاین — نمایش از حافظهٔ محلی/)).toBeTruthy()
    })
    screen.unmount()
  })

  it("deletes a one-off event locally without waiting for the server", async () => {
    const today = todayIn(TIME_ZONE)
    const id = uuidV7()
    eventSources = [allDayEvent({ id, date: today, title: "یک‌بار" })]
    await withStore(async (store) => {
      await store.writeLocal({
        entityType: "event",
        entityId: id,
        op: "upsert",
        patch: {
          id,
          type: "event",
          title: "یک‌بار",
          description: null,
          location: null,
          category: null,
          people: [],
          timing: { _tag: "allDay", date: today },
          timeZone: TIME_ZONE,
          recurrence: null,
          exceptions: [],
          occasionId: null,
          color: null,
          visibility: "shared",
          createdAt: new Date().toISOString()
        }
      })
      const queued = await store.pending()
      await store.ack(queued.map((entry) => entry.clientMutationId))
    })

    const screen = mountCalendar()
    await waitForSource(screen, "server")
    await eventually(() => expect(screen.getByText("یک‌بار")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "یک‌بار" }))
    await screen.findByRole("dialog", { name: "رویداد" })
    // The series has to land in the mirror before the editor can write.
    await eventually(() => {
      expect(
        (within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
          name: "حذف رویداد"
        }) as HTMLButtonElement).disabled
      ).toBe(false)
    })
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
        name: "حذف رویداد"
      })
    )

    await eventually(() => {
      expect(screen.queryByText("یک‌بار")).toBeNull()
      // Still painting the same server snapshot, now with the local tombstone.
      expect(screen.container.querySelector('main[data-source="server"]')).toBeTruthy()
      expect(screen.getByText("رویداد حذف شد: یک‌بار")).toBeTruthy()
    })
    screen.unmount()
  })

  it("asks the edit scope and applies 'this event' as one exception", async () => {
    const today = todayIn(TIME_ZONE)
    const anchor = shiftFrom(today, -14)
    await withStore(async (store) => {
      await seedRecurringEvent(store, { anchor, title: "جلسهٔ هفتگی" })
    })
    // A single-row occurrence edit is the safe offline path.
    setOnline(false)
    stubNetwork({ week: "fail", month: "fail" })

    const screen = mountCalendar()
    await waitForSource(screen, "mirror")
    await eventually(() => {
      expect(screen.getByText("جلسهٔ هفتگی")).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: "جلسهٔ هفتگی" }))
    await screen.findByRole("dialog", { name: "رویداد" })
    await eventually(() => {
      expect(
        (within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
          name: "ذخیره"
        }) as HTMLButtonElement).disabled
      ).toBe(false)
    })
    fireEvent.input(
      within(screen.getByRole("dialog", { name: "رویداد" })).getByLabelText("عنوان رویداد"),
      { target: { value: "تیتر تازه" } }
    )
    flush()
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
        name: "ذخیره"
      })
    )
    flush()

    const prompt = await screen.findByRole("dialog", { name: "این رویداد یا این رویداد و رویدادهای بعدی؟" })
    expect(within(prompt).getByRole("radiogroup")).toBeTruthy()
    expect(
      within(prompt).getByRole("radio", { name: /فقط این رویداد/ })
    ).toBeTruthy()
    expect(
      within(prompt).getByRole("radio", { name: /این رویداد و رویدادهای بعدی/ })
    ).toBeTruthy()
    fireEvent.click(within(prompt).getByRole("button", { name: "ادامه" }))

    await eventually(async () => {
      await withStore(async (store) => {
        const events = await store.list("event")
        expect(events).toHaveLength(1)
        const exceptions = events[0]!.data.exceptions as ReadonlyArray<Record<string, unknown>>
        expect(exceptions).toHaveLength(1)
        expect(exceptions[0]).toMatchObject({
          instanceId: today,
          action: "override",
          overrides: { title: "تیتر تازه" }
        })
      })
    })
    await eventually(() => {
      expect(screen.getByText("رویداد ویرایش شد: تیتر تازه")).toBeTruthy()
    })
    screen.unmount()
  })

  it("does not offer a split edit offline (two LWW rows cannot be gated)", async () => {
    const today = todayIn(TIME_ZONE)
    const anchor = shiftFrom(today, -14)
    await withStore(async (store) => {
      await seedRecurringEvent(store, { anchor, title: "جلسهٔ هفتگی" })
    })
    setOnline(false)
    stubNetwork({ week: "fail", month: "fail" })

    const screen = mountCalendar()
    await waitForSource(screen, "mirror")
    await eventually(() => expect(screen.getByText("جلسهٔ هفتگی")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "جلسهٔ هفتگی" }))
    await screen.findByRole("dialog", { name: "رویداد" })
    await eventually(() => {
      expect(
        (within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
          name: "ذخیره"
        }) as HTMLButtonElement).disabled
      ).toBe(false)
    })
    fireEvent.input(
      within(screen.getByRole("dialog", { name: "رویداد" })).getByLabelText("عنوان رویداد"),
      { target: { value: "نسخهٔ دوم" } }
    )
    flush()
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "رویداد" })).getByRole("button", {
        name: "ذخیره"
      })
    )

    const prompt = await screen.findByRole("dialog", { name: "این رویداد یا این رویداد و رویدادهای بعدی؟" })
    const split = within(prompt).getByRole("radio", {
      name: /این رویداد و رویدادهای بعدی/
    }) as HTMLInputElement
    expect(split.disabled).toBe(true)
    expect(within(prompt).getByText(/به سرور متصل باشید/)).toBeTruthy()

    // Escape closes only the prompt: the editor (and the draft) stay open.
    fireEvent.keyDown(document, { key: "Escape" })
    await eventually(() => {
      expect(screen.queryByRole("dialog", { name: "این رویداد یا این رویداد و رویدادهای بعدی؟" })).toBeNull()
      expect(screen.getByRole("dialog", { name: "رویداد" })).toBeTruthy()
    })

    // Nothing was split while the option was refused: still the one seeded
    // series (and only its original outbox entry).
    await withStore(async (store) => {
      expect(await store.list("event")).toHaveLength(1)
      expect(await store.pending()).toHaveLength(1)
    })
    screen.unmount()
  })
})

/** A weekly all-day series anchored two weeks before today. */
const seedRecurringEvent = async (
  store: LocalStore,
  input: { readonly anchor: string; readonly title: string }
): Promise<string> => {
  const id = uuidV7()
  await store.writeLocal({
    entityType: "event",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "event",
      title: input.title,
      description: null,
      location: null,
      category: null,
      people: [],
      timing: { _tag: "allDay", date: input.anchor },
      timeZone: TIME_ZONE,
      recurrence: {
        frequency: "weekly",
        interval: 1,
        byDay: [isoWeekdayOf(input.anchor)],
        end: { _tag: "never" }
      },
      exceptions: [],
      occasionId: null,
      color: null,
      visibility: "shared",
      createdAt: new Date().toISOString()
    }
  })
  return id
}
