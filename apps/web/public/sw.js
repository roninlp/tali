/*
 * Tali service worker — Web Push shell (Slice 1 / ticket #20).
 *
 * Scope of this file: receive a push, show an actionable notification, and
 * record the Done/Snooze response somewhere durable. Scheduling, encryption,
 * and the dispatch ledger are NOT here (later slice); a local test script or
 * any future dispatcher sends the push.
 *
 * Keep in sync with `apps/web/src/lib/push/notification-actions.ts`
 * (IndexedDB names) and `packages/domain/src/push.ts` (payload shape).
 */

const PUSH_DB_NAME = "tali.push.v1"
const PUSH_ACTIONS_STORE = "actions"
const PUSH_CONFIG_CACHE = "tali-push-config-v1"
const PUSH_CONFIG_URL = "/__tali/push-config"
const DEFAULT_URL = "/reminders"

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

// The page shares the VAPID public key so `pushsubscriptionchange` can
// resubscribe even when no tab is open.
self.addEventListener("message", (event) => {
  const data = event.data
  if (data && data.type === "tali:push-config" && typeof data.applicationServerKey === "string") {
    event.waitUntil(saveConfig(data.applicationServerKey))
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
    event.waitUntil(
      handleReminderAction({
        reminderId: typeof data.id === "string" ? data.id : "",
        action,
        at: new Date().toISOString()
      })
    )
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

  await self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "",
    // Re-deliveries of the same reminder replace the previous notification.
    tag: `reminder:${id}`,
    data: {
      ...payload,
      id,
      url: typeof payload.url === "string" ? payload.url : DEFAULT_URL
    },
    actions: [
      { action: "done", title: "انجام شد" },
      { action: "snooze", title: "بعداً" }
    ],
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
 * Stub response handler: append to the device-local queue and tell any open
 * window. The reminder slice will drain this into the sync outbox /
 * `ReminderDispatch` ledger instead of keeping it device-local.
 */
async function handleReminderAction(record) {
  try {
    await enqueueAction(record)
  } catch (error) {
    console.warn("[tali] could not queue reminder action", error)
  }
  await broadcast({ type: "tali:reminder-action", ...record })
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
  const applicationServerKey = await loadConfig()
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

async function saveConfig(applicationServerKey) {
  const cache = await caches.open(PUSH_CONFIG_CACHE)
  await cache.put(
    PUSH_CONFIG_URL,
    new Response(applicationServerKey, { headers: { "content-type": "text/plain" } })
  )
}

async function loadConfig() {
  const cache = await caches.open(PUSH_CONFIG_CACHE)
  const response = await cache.match(PUSH_CONFIG_URL)
  return response ? (await response.text()).trim() : ""
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
