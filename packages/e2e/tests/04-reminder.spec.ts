import { expect, inboxItems, pushApplied, sweepReminders, test, uniqueTag, uuidV7 } from "./support"

/**
 * Gate flow 4 (#81/#84): a medication reminder fires → Done from the
 * notification → `/reminders` reflects the answer.
 *
 * Two seams are deliberate and recorded here:
 *
 * 1. **No reminder UI.** `/reminders` is the inbox; a reminder is created
 *    through `/sync/push` (the offline-first transport the app itself uses).
 *    `kind: "medication"` makes the server derive `tier: "critical"`, so the
 *    fire bypasses quiet hours and is claimable at any hour.
 * 2. **No OS notification.** `alchemy dev` cannot send a real Web Push and
 *    Playwright cannot click one. The flow writes the record the service
 *    worker would write on a Done tap (`tali.push.v1` → `actions`) and reloads
 *    the page: the real page-drain then posts
 *    `POST /reminders/dispatches/:id/respond`. That is the production path
 *    after the tap, not a shortcut around it — the only simulated part is the
 *    notification click itself.
 */
test("flow 4: a fired medication reminder is answered Done from the notification queue", async ({
  alicePage,
  aliceApi
}, testInfo) => {
  const tag = uniqueTag()
  const title = `داروی فشار ${tag}`
  const reminderId = uuidV7()

  await pushApplied(aliceApi, {
    entityType: "reminder",
    entityId: reminderId,
    patch: {
      title,
      kind: "medication",
      repeat: { _tag: "once" },
      // A minute in the past: the sweep's catch-up query claims it.
      fireAt: new Date(Date.now() - 60_000).toISOString(),
      offsetMinutes: 0,
      link: { _tag: "none" },
      timeZone: "Asia/Tehran",
      visibility: "shared"
    }
  })

  const sweep = await sweepReminders(aliceApi)
  expect(sweep.claimed, "the sweep claimed the due reminder").toBeGreaterThanOrEqual(1)

  // ── The fire is in the missed inbox ────────────────────────────────────
  await alicePage.goto("/reminders")
  const inboxRow = alicePage.locator("li").filter({ hasText: title })
  await expect(inboxRow).toBeVisible()

  const [item] = (await inboxItems(aliceApi)).filter((entry) => entry.title === title)
  expect(item, "the dispatch is owed in the ledger").toBeDefined()
  expect(item!.kind).toBe("medication")
  const dispatchId = item!.dispatch.id

  // ── The notification's Done tap, as the service worker records it ──────
  await alicePage.evaluate(async ({ dispatchId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tali.push.v1", 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains("actions")) {
          database.createObjectStore("actions", { keyPath: "seq", autoIncrement: true })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("open failed"))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("actions", "readwrite")
        transaction.objectStore("actions").add({
          dispatchId,
          action: "done",
          at: new Date().toISOString()
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error("write failed"))
      })
    } finally {
      db.close()
    }
  }, { dispatchId })

  // The page drain runs on mount; the reload is the "browser reopen".
  await alicePage.reload()
  await expect(alicePage.getByText("یادآوری بی‌پاسخی نیست", { exact: false })).toBeVisible()

  // ── The ledger moved the answer to history ─────────────────────────────
  await alicePage.getByRole("button", { name: "تاریخچه" }).click()
  await expect(alicePage.getByRole("heading", { name: "تاریخچه‌ی یادآوری‌ها" })).toBeVisible()
  await expect(alicePage.locator("li").filter({ hasText: title })).toContainText("انجام شد")

  const history = await inboxItems(aliceApi, true)
  const answered = history.find((entry) => entry.title === title)
  expect(answered?.dispatch.response, "the server recorded Done").toBe("done")

  await testInfo.attach("reminder.json", {
    body: JSON.stringify({ title, reminderId, dispatchId }, null, 2),
    contentType: "application/json"
  })
})
