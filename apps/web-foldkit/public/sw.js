/*
 * Tali service worker — Web Push delivery and the Done/Snooze answer
 * (tickets #20 and #61).
 *
 * Scope of this file:
 *   - receive a push and show an actionable notification;
 *   - on Done/Snooze, append the answer to a durable device-local queue, then
 *     try to post it to `POST /reminders/dispatches/:id/respond` right away.
 *
 * The queue is written **before** the network attempt, so an offline tap is
 * never lost; a failed flush is retried by the page on its next open
 * (`apps/web/src/lib/push/notification-actions.ts`) and by the next tap. The
 * server ledger, not the push, remains the source of truth: a browser that
 * never saw the notification still finds the dispatch in the missed inbox.
 *
 * The payload's `id` is the **dispatch id** (one fire = one row = one answer).
 * Keep this file in sync with `apps/web/src/lib/push/notification-actions.ts`
 * (IndexedDB names) and `packages/domain/src/push.ts` (payload shape).
 */

const PUSH_DB_NAME = "tali.push.v1"
const PUSH_ACTIONS_STORE = "actions"
const PUSH_CONFIG_CACHE = "tali-push-config-v2"
const PUSH_CONFIG_URL = "/__tali/push-config"
const DEFAULT_URL = "/reminders"
const DEFAULT_SNOOZE_MINUTES = 10

self.addEventListener("install", () => {
  // A push worker should take over promptly; the app shell itself is not cached
  // here (the local-first store owns offline data).
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

// Chrome's installability heuristic expects a fetch handler. This one is
// deliberately network-only: offline data lives in IndexedDB, not the HTTP cache.
self.addEventListener("fetch", () => {})

// The page shares the VAPID public key and the API origin so
// `pushsubscriptionchange` can resubscribe and an action can be flushed even
// when no tab is open.
self.addEventListener("message", (event) => {
  const data = event.data
  if (data === null || typeof data !== "object") return
  if (data.type === "tali:push-config") {
    event.waitUntil(saveConfig(data))
  } else if (data.type === "tali:flush-reminder-actions") {
    event.waitUntil(flushActions())
  }
})

self.addEventListener("push", (event) => {
  let payload = {}
  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      payload = { title: "یادآوری تالی", body: event.data.text() }
    }
  }
  event.waitUntil(showReminder(payload))
})

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification
  notification.close()

  const data = notification.data || {}
  const action = event.action

  if (action === "done" || action === "snooze") {
    event.waitUntil(handleReminderAction({ data, action }))
    return
  }

  // Body tap: land on the missed-reminder inbox.
  event.waitUntil(openApp(typeof data.url === "string" ? data.url : DEFAULT_URL))
})

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe())
})

async function showReminder(payload) {
  const id = typeof payload.id === "string" ? payload.id : "tali-reminder"
  const title = typeof payload.title === "string" ? payload.title : "یادآوری تالی"
  const critical = payload.tier === "critical" || payload.tier === "medication"
  const actions = Array.isArray(payload.actions) && payload.actions.length > 0
    ? payload.actions
    : [
      { action: "done", title: "انجام شد" },
      { action: "snooze", title: "بعداً", minutes: DEFAULT_SNOOZE_MINUTES }
    ]

  await self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "",
    // Re-deliveries of the same dispatch replace the previous notification;
    // the push `Topic` is a hash, so the tag keeps the readable full id.
    tag: `reminder:${id}`,
    data: {
      ...payload,
      id,
      actions,
      url: typeof payload.url === "string" ? payload.url : DEFAULT_URL
    },
    // `Notification.actions` accepts only action/title/icon/navigate; the
    // snooze length travels in `data`, not in the OS button.
    actions: actions.map((action) => ({ action: action.action, title: action.title })),
    // Medication reminders stay until the user acts (policy draft §2.2).
    requireInteraction: critical,
    dir: "rtl",
    lang: "fa",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    timestamp: Date.now()
  })
}

/**
 * Persist the answer first, then attempt the network. The record shape is the
 * page's `QueuedReminderAction`: `dispatchId`, `action`, `snoozeMinutes`, `at`.
 */
async function handleReminderAction({ data, action }) {
  const dispatchId = typeof data.id === "string" ? data.id : ""
  if (dispatchId === "") return
  const snoozeAction = Array.isArray(data.actions)
    ? data.actions.find((candidate) => candidate && candidate.action === "snooze")
    : undefined
  const record = {
    dispatchId,
    action,
    snoozeMinutes: action === "snooze"
      ? (Number.isInteger(snoozeAction && snoozeAction.minutes)
        ? snoozeAction.minutes
        : DEFAULT_SNOOZE_MINUTES)
      : undefined,
    at: new Date().toISOString()
  }
  try {
    await enqueueAction(record)
  } catch (error) {
    console.warn("[tali] could not queue reminder action", error)
  }
  await flushActions()
  await broadcast({ type: "tali:reminder-action", ...record })
}

/**
 * Post every queued answer, deleting the ones the server accepted. The API is
 * same-site (the session cookie is sent with `credentials: "include"`) and the
 * respond route is idempotent, so a duplicate tap is a no-op rather than a
 * second answer.
 */
async function flushActions() {
  const config = await loadConfig()
  const apiUrl = config.apiUrl || self.location.origin
  let records
  try {
    records = await readActions()
  } catch (error) {
    console.warn("[tali] could not read the reminder queue", error)
    return
  }
  for (const record of records) {
    if (!Number.isInteger(record.seq) || typeof record.dispatchId !== "string") continue
    let response
    try {
      response = await fetch(
        `${apiUrl}/reminders/dispatches/${encodeURIComponent(record.dispatchId)}/respond`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            record.action === "snooze"
              ? { response: "snooze", snoozeMinutes: record.snoozeMinutes || DEFAULT_SNOOZE_MINUTES }
              : { response: record.action }
          )
        }
      )
    } catch {
      // Offline: keep the record for the page's next drain.
      continue
    }
    // 2xx = answered; 404 = the dispatch is gone (nothing can fix it). A 4xx
    // body/session failure is retried by the page after the next sign-in.
    if (response.ok || response.status === 404) {
      try {
        await deleteAction(record.seq)
      } catch (error) {
        console.warn("[tali] could not clear the reminder queue", error)
      }
    }
  }
}

async function openApp(url) {
  const target = new URL(url, self.location.origin)
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  for (const client of windows) {
    if (new URL(client.url).origin === target.origin) {
      await client.focus()
      if ("navigate" in client) await client.navigate(target.href)
      return
    }
  }
  await self.clients.openWindow(target.href)
}

async function resubscribe() {
  const config = await loadConfig()
  const applicationServerKey = config.applicationServerKey
  if (!applicationServerKey) {
    // No key cached yet: ask a page to re-run the subscription flow.
    await broadcast({ type: "tali:push-subscription-change" })
    return
  }
  try {
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(applicationServerKey)
    })
    // The page registers the new endpoint with `/push/register` (the session
    // cookie lives with the page, not the worker).
    await broadcast({
      type: "tali:push-subscription-change",
      subscription: subscription.toJSON()
    })
  } catch (error) {
    console.warn("[tali] push resubscribe failed", error)
    await broadcast({ type: "tali:push-subscription-change" })
  }
}

async function broadcast(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  for (const client of windows) client.postMessage(message)
}

async function saveConfig(data) {
  const cache = await caches.open(PUSH_CONFIG_CACHE)
  await cache.put(
    PUSH_CONFIG_URL,
    new Response(
      JSON.stringify({
        applicationServerKey: typeof data.applicationServerKey === "string"
          ? data.applicationServerKey
          : "",
        apiUrl: typeof data.apiUrl === "string" ? data.apiUrl : ""
      }),
      { headers: { "content-type": "application/json" } }
    )
  )
}

async function loadConfig() {
  try {
    const cache = await caches.open(PUSH_CONFIG_CACHE)
    const response = await cache.match(PUSH_CONFIG_URL)
    if (!response) return {}
    return await response.json()
  } catch {
    return {}
  }
}

function decodeBase64Url(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PUSH_ACTIONS_STORE)) {
        db.createObjectStore(PUSH_ACTIONS_STORE, { keyPath: "seq", autoIncrement: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("Could not open the push queue"))
  })
}

async function readActions() {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(PUSH_ACTIONS_STORE, "readonly")
        .objectStore(PUSH_ACTIONS_STORE)
        .getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error || new Error("Could not read the push queue"))
    })
  } finally {
    db.close()
  }
}

async function enqueueAction(record) {
  const db = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(PUSH_ACTIONS_STORE, "readwrite")
      transaction.objectStore(PUSH_ACTIONS_STORE).add(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error("Push queue write failed"))
      transaction.onabort = () => reject(transaction.error || new Error("Push queue write aborted"))
    })
  } finally {
    db.close()
  }
}

async function deleteAction(seq) {
  const db = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(PUSH_ACTIONS_STORE, "readwrite")
      transaction.objectStore(PUSH_ACTIONS_STORE).delete(seq)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error("Push queue delete failed"))
    })
  } finally {
    db.close()
  }
}
