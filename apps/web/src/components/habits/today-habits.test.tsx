import "fake-indexeddb/auto"
import { flush } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toIsoDate, todayInTimeZone, uuidV7 } from "@tali/domain"
import { openLocalStore } from "../../lib/local-store/store"
import type { LocalStore } from "../../lib/local-store/types"
import { createHabitInMirror } from "../../lib/habits/model"
import { TodayHabits } from "./today-habits"

/**
 * Ticket #66 exit criterion at the lane seam: one tap moves the streak badge
 * immediately, with the network unavailable, because the tap only commits the
 * mirror + outbox. An X-per-week habit's 7-day rate renders progress instead of
 * a fabricated 0%.
 */

const ZONE = "UTC"
const today = (): string => toIsoDate(todayInTimeZone(ZONE))

const eventually = async (assert: () => void): Promise<void> => {
  await waitFor(() => {
    flush()
    assert()
  })
}

const click = (element: Element) => {
  fireEvent.click(element)
  flush()
}

const open = (): Promise<LocalStore> => openLocalStore(`today-habits-${uuidV7()}`)

const renderLane = (store: LocalStore) =>
  render(() => (
    <TodayHabits store={store} timeZone={ZONE} digits="persian" today={today()} />
  ))

describe("TodayHabits", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("moves the badge on one tap with no network, cycling Done → Partial → Missed", async () => {
    const network = vi.fn(() => {
      throw new Error("the habit tap must not use the network")
    })
    globalThis.fetch = network as unknown as typeof fetch

    const store = await open()
    await createHabitInMirror(
      store,
      { title: "آب", frequency: { _tag: "daily" }, timeZone: ZONE },
      new Date().toISOString()
    )
    const screen = renderLane(store)

    await eventually(() =>
      expect(screen.getByLabelText("زنجیره: بدون زنجیره")).toBeTruthy()
    )

    click(screen.getByRole("button", { name: "تغییر وضعیت آب" }))
    await eventually(() => expect(screen.getByText("✓")).toBeTruthy())
    expect(screen.getByText("انجام شد")).toBeTruthy()
    expect(screen.getByLabelText("زنجیره: ۱ روز پیاپی")).toBeTruthy()

    click(screen.getByRole("button", { name: "تغییر وضعیت آب" }))
    await eventually(() => expect(screen.getByText("◐")).toBeTruthy())
    expect(screen.getByText("نیمه")).toBeTruthy()
    // Partial is full credit for the streak.
    expect(screen.getByLabelText("زنجیره: ۱ روز پیاپی")).toBeTruthy()

    click(screen.getByRole("button", { name: "تغییر وضعیت آب" }))
    await eventually(() => expect(screen.getByText("✕")).toBeTruthy())
    expect(screen.getByText("از دست رفت")).toBeTruthy()
    expect(screen.getByLabelText("زنجیره: بدون زنجیره")).toBeTruthy()

    expect(network).not.toHaveBeenCalled()
    expect(await store.pending()).toHaveLength(4)

    screen.unmount()
    store.close()
  })

  it("shows an unsatisfied week's progress and never 0% for a 7-day rate", async () => {
    const store = await open()
    await createHabitInMirror(
      store,
      { title: "ورزش", frequency: { _tag: "weekly", times: 3 }, timeZone: ZONE },
      new Date().toISOString()
    )
    const screen = renderLane(store)

    await eventually(() => expect(screen.getByText("۰ از ۳ این هفته")).toBeTruthy())
    expect(screen.queryByText("۰٪")).toBeNull()
    expect(screen.getAllByText("نرخ ۷ روزه").length).toBe(1)

    click(screen.getByRole("button", { name: "تغییر وضعیت ورزش" }))
    await eventually(() => expect(screen.getByText("۱ از ۳ این هفته")).toBeTruthy())
    expect(screen.queryByText("۰٪")).toBeNull()
    // The counting week is named on the stats row (fixed Saturday–Friday).
    expect(screen.getByLabelText(/زنجیره:/)).toBeTruthy()

    screen.unmount()
    store.close()
  })
})
