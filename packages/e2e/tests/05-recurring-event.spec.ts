import { addDays, expect, isoWeekday, pullAll, pushApplied, tehranToday, test, uniqueTag, uuidV7 } from "./support"

/**
 * Gate flow 5 (#81/#84): a recurring event appears in the week and month views,
 * and a "this and following" edit splits the series.
 *
 * Seam: there is no recurrence UI — `EventQuickAdd` writes `recurrence: null`.
 * The series is therefore seeded through `/sync/push`, the same transport the
 * offline client uses, and the flow then exercises the real editor and the real
 * scope prompt. The series is anchored two weeks back so the edited occurrence
 * is not its first; a first-occurrence edit deliberately degrades to a
 * whole-series edit (`event-recurrence.ts`), which is not what this gate is
 * about.
 *
 * The split is asserted twice: in the calendar (old title before the split,
 * new title from it) and in the household feed (the old row truncated `until`
 * the day before, the tail row anchored on the occurrence with a new id).
 */
test("flow 5: a recurring event splits on a this-and-following edit", async ({
  alicePage,
  aliceApi
}, testInfo) => {
  const tag = uniqueTag()
  const today = tehranToday()
  const anchor = addDays(today, -14)
  const title = `جلسهٔ هفتگی ${tag}`
  const newTitle = `جلسهٔ هفتگی ${tag} — بازنگری`
  const eventId = uuidV7()

  await pushApplied(aliceApi, {
    entityType: "event",
    entityId: eventId,
    patch: {
      title,
      timing: { _tag: "allDay", date: anchor },
      timeZone: "Asia/Tehran",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        byDay: [isoWeekday(anchor)],
        end: { _tag: "never" }
      },
      description: null,
      location: null,
      category: null,
      people: [],
      exceptions: [],
      occasionId: null,
      color: null,
      visibility: "shared"
    }
  })

  // ── The series shows up in the week view ───────────────────────────────
  await alicePage.goto("/calendar")
  const chip = alicePage.getByRole("button", { name: title, exact: true })
  await expect(chip).toBeVisible()
  await chip.click()

  // ── Edit the title, then choose "this and following" ───────────────────
  const editor = alicePage.getByRole("dialog", { name: "رویداد" })
  await expect(editor).toBeVisible()
  await editor.getByLabel("عنوان رویداد").fill(newTitle)

  const save = editor.getByRole("button", { name: "ذخیره" })
  // Save stays disabled until the series has reached the local mirror.
  await expect(save).toBeEnabled()
  await save.click()

  const prompt = alicePage.getByRole("dialog", {
    name: "این رویداد یا این رویداد و رویدادهای بعدی؟"
  })
  await expect(prompt).toBeVisible()
  await prompt.getByRole("radio", { name: /این رویداد و رویدادهای بعدی/ }).check()
  await prompt.getByRole("button", { name: "ادامه" }).click()

  await expect(
    alicePage.getByText(`این رویداد و رویدادهای بعدی ویرایش شد: ${newTitle}`)
  ).toBeVisible()

  // ── Week view: the tail starts at the split, the head stops before it ──
  await expect(alicePage.getByRole("button", { name: newTitle, exact: true })).toBeVisible()

  await alicePage.getByRole("button", { name: "هفتهٔ قبل" }).click()
  await expect(alicePage.getByRole("button", { name: title, exact: true })).toBeVisible()
  await expect(alicePage.getByRole("button", { name: newTitle, exact: true })).toHaveCount(0)

  await alicePage.getByRole("button", { name: "هفتهٔ بعد" }).click()
  await expect(alicePage.getByRole("button", { name: newTitle, exact: true })).toBeVisible()

  // ── Month view: the split occurrence opens under its new title ─────────
  await alicePage.getByRole("button", { name: "ماه", exact: true }).click()
  await alicePage.locator('.calendar-month-day[data-today="true"]').click()
  await expect(
    alicePage.getByRole("button", { name: `بازکردن ${newTitle}` })
  ).toBeVisible()

  // ── The feed holds two rows: truncated head, anchored tail ─────────────
  const events = (await pullAll(aliceApi)).filter((row) => row.entityType === "event")
  const head = events.find((row) => row.entityId === eventId)
  const tail = events.find((row) => row.data.title === newTitle)

  expect(head, "the original series row is still present").toBeDefined()
  expect(head!.data.recurrence).toEqual({
    frequency: "weekly",
    interval: 1,
    byDay: [isoWeekday(anchor)],
    end: { _tag: "until", date: addDays(today, -1) }
  })
  expect(head!.version).toBe(2)

  expect(tail, "the tail row is a new event").toBeDefined()
  expect(tail!.entityId).not.toBe(eventId)
  expect(tail!.data.timing).toEqual({ _tag: "allDay", date: today })

  await testInfo.attach("event-split.json", {
    body: JSON.stringify(
      { title, newTitle, eventId, tailId: tail?.entityId, splitDate: today },
      null,
      2
    ),
    contentType: "application/json"
  })
})
