import { flush, createSignal } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { TaskCreateDraft } from "../../lib/tasks/model"
import { QuickAdd } from "./quick-add"

/**
 * Quick-add is the one surface that silently dates a task, so its default due
 * day has to follow the viewer's live wall date: a form left open across
 * midnight must not save yesterday's date as an all-day due date.
 */

const mount = (drafts: Array<TaskCreateDraft>) => {
  const [day, setDay] = createSignal("2026-10-21")
  const screen = render(() => (
    <QuickAdd
      disabled={false}
      timeZone="UTC"
      today={day()}
      digits="persian"
      projects={[]}
      tags={[]}
      onCreate={async (draft) => {
        drafts.push(draft)
      }}
      onCreateProject={async () => undefined}
      onCreateTag={async () => undefined}
    />
  ))
  return { screen, setDay }
}

const type = (element: Element, value: string) => {
  fireEvent.input(element, { target: { value } })
  flush()
}

const submit = async (screen: ReturnType<typeof mount>["screen"]) => {
  type(screen.getByLabelText("عنوان کار تازه"), "خرید شیر")
  fireEvent.click(screen.getByRole("button", { name: "افزودن" }))
  flush()
}

describe("QuickAdd due date", () => {
  it("dates a new task with today, and follows the day rollover", async () => {
    const drafts: Array<TaskCreateDraft> = []
    const { screen, setDay } = mount(drafts)
    await waitFor(() => expect((screen.getByLabelText("عنوان کار تازه") as HTMLInputElement).disabled).toBe(false))

    await submit(screen)
    await waitFor(() => expect(drafts).toHaveLength(1))
    expect(drafts[0]!.dueDate).toBe("2026-10-21")

    // The screen keeps ticking; midnight passes while the form is still open.
    setDay("2026-10-22")
    flush()
    await submit(screen)
    await waitFor(() => expect(drafts).toHaveLength(2))
    expect(drafts[1]!.dueDate).toBe("2026-10-22")

    screen.unmount()
  })

  it("does not re-date a day the user picked explicitly", async () => {
    const drafts: Array<TaskCreateDraft> = []
    const { screen, setDay } = mount(drafts)

    fireEvent.click(screen.getByRole("button", { name: /موعد/ }))
    flush()
    fireEvent.click(screen.getByRole("button", { name: "بدون تاریخ" }))
    flush()

    setDay("2026-10-22")
    flush()
    await submit(screen)
    await waitFor(() => expect(drafts).toHaveLength(1))
    expect(drafts[0]!.dueDate).toBeNull()

    screen.unmount()
  })
})
