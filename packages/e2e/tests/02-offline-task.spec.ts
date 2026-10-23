import { expect, pullAll, syncStatus, test, uniqueTag } from "./support"

/**
 * Gate flow 2 (#81/#84): offline quick-add → reload while offline → reconnect
 * → the rows converge on both devices.
 *
 * Offline seam: the SPA is served by Vite in dev and its service worker
 * deliberately caches no app shell (`apps/web/public/sw.js`), so a real
 * `context.setOffline(true)` reload cannot load the document at all. The flow
 * instead makes the browser *believe* it is offline (`navigator.onLine` is
 * false, the app's own signal) and cuts the API origin: the document still
 * comes from Vite, while auth, `/today` and the sync engine all fail. That is
 * exactly the state the mirror has to survive.
 *
 * The two rows prove both halves: one was acknowledged before the outage (so
 * the mirror, not the outbox, is what survives the reload), the other is
 * queued while offline and must still be pending after the reload.
 */
test("flow 2: offline quick-adds survive a reload and converge on both devices", async ({
  alice,
  alicePage,
  bobPage,
  aliceApi,
  bobApi
}, testInfo) => {
  const tag = uniqueTag()
  const syncedTitle = `نان ${tag}`
  const offlineTitle = `شیر ${tag}`

  // ── A adds a task online and waits for it to be acknowledged ───────────
  await alicePage.goto("/today")
  const composer = alicePage.getByLabel("کار تازه برای امروز")
  await expect(composer).toBeEnabled()
  await composer.fill(syncedTitle)
  await composer.press("Enter")
  await expect(alicePage.locator(".today-list")).toContainText(syncedTitle)
  await expect(syncStatus(alicePage)).not.toContainText("در انتظار ارسال")

  // ── The device goes offline; the page reloads from the local mirror ────
  await alice.addInitScript(() => {
    let online = false
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => online
    })
    // The test's "reconnect" switch: flip the signal the app listens to and
    // dispatch the browser event it would have received.
    ;(window as unknown as { __taliSetOnline: (next: boolean) => void }).__taliSetOnline = (next) => {
      online = next
      window.dispatchEvent(new Event(next ? "online" : "offline"))
    }
  })
  await alice.route("http://localhost:8787/**", (route) => route.abort("connectionrefused"))
  await alicePage.reload()

  await expect(alicePage.locator("p.today-source")).toHaveAttribute("data-offline", "true")
  await expect(alicePage.locator("p.today-source")).toContainText("آفلاین")
  // The acknowledged row survived because it was in IndexedDB, not memory.
  await expect(alicePage.locator(".today-list")).toContainText(syncedTitle)

  // ── A second task is queued while offline, then survives another reload ─
  await composer.fill(offlineTitle)
  await composer.press("Enter")
  await expect(alicePage.locator(".today-list")).toContainText(offlineTitle)
  // The pill reports the outage, not the queue depth: while offline it reads
  // "آفلاین", and the queued rows are proven by surviving the reload below.
  await expect(syncStatus(alicePage)).toHaveText("آفلاین")

  await alicePage.reload()
  await expect(alicePage.locator(".today-list")).toContainText(syncedTitle)
  await expect(alicePage.locator(".today-list")).toContainText(offlineTitle)
  await expect(syncStatus(alicePage)).toHaveText("آفلاین")

  // ── Reconnect: the outbox drains and B pulls both rows ─────────────────
  await alice.unroute("http://localhost:8787/**")
  await alicePage.evaluate(() => {
    ;(window as unknown as { __taliSetOnline: (next: boolean) => void }).__taliSetOnline(true)
  })
  await expect(syncStatus(alicePage)).toHaveText("همگام")

  await bobPage.goto("/tasks")
  await expect(bobPage.getByText(syncedTitle, { exact: true })).toBeVisible()
  await expect(bobPage.getByText(offlineTitle, { exact: true })).toBeVisible()

  // The authoritative rows prove a real push/pull, not two optimistic mirrors.
  const rows = await pullAll(aliceApi)
  const synced = rows.find((row) => row.entityType === "task" && row.data.title === syncedTitle)
  const queued = rows.find((row) => row.entityType === "task" && row.data.title === offlineTitle)
  expect(synced, "the online task reached the household feed").toBeDefined()
  expect(queued, "the offline task was pushed on reconnect").toBeDefined()

  const bobRows = await pullAll(bobApi)
  expect(
    bobRows.some((row) => row.entityType === "task" && row.data.title === offlineTitle),
    "B's cursor sees the offline row"
  ).toBeTruthy()

  await testInfo.attach("tasks.json", {
    body: JSON.stringify(
      { syncedTitle, offlineTitle, syncedId: synced?.entityId, queuedId: queued?.entityId },
      null,
      2
    ),
    contentType: "application/json"
  })
})
