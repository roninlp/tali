import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type ParentProps
} from "solid-js"
import { API_URL } from "../config"
import { useAuth } from "../auth"
import { loadVapidPublicKey, urlBase64ToUint8Array } from "./config"
import {
  readQueuedReminderActions,
  type QueuedReminderAction
} from "./notification-actions"
import { registerPushSubscription, type PushRegistrationFailure } from "./push-api"
import {
  isInstalled,
  isPushSupported,
  isSecureContext,
  readyRegistration,
  registerServiceWorker
} from "./service-worker"

/**
 * The client half of the Web Push shell (ticket #20).
 *
 * Owns: service-worker registration, the VAPID-restricted `PushSubscription`
 * (with the key read from `GET /push/vapid`), its registration with
 * `POST /push/register`, and the permission/health state `/reminders` and
 * `/settings` render.
 *
 * What it deliberately does **not** own: scheduling or dispatch. The server's
 * per-minute sweep sends; this provider makes sure the device is subscribed and
 * the worker knows the API origin.
 */

export type PushPermission = NotificationPermission | "unsupported"

export interface PushContextValue {
  supported: () => boolean
  secure: () => boolean
  installed: () => boolean
  configured: () => boolean
  /** The server's VAPID public key (empty while unknown / unconfigured). */
  publicKey: () => string
  permission: () => PushPermission
  subscribed: () => boolean
  busy: () => boolean
  error: () => string | undefined
  /** Last Done/Snooze tap the service worker queued (stub consumer). */
  lastAction: () => QueuedReminderAction | undefined
  /** Request permission + subscribe + register. Must be called from a user gesture. */
  enable: () => Promise<void>
  /** Drop this device's subscription. */
  disable: () => Promise<void>
  /** Re-read browser state and (when signed in) re-register an existing subscription. */
  refresh: () => Promise<void>
  /** The raw subscription JSON, for the local test-push script. */
  subscriptionJson: () => PushSubscriptionJSON | undefined
}

const PushContext = createContext<PushContextValue>()

const FAILURE_MESSAGE: Record<PushRegistrationFailure, string> = {
  Unauthorized: "برای ثبت اشتراک اعلان باید وارد شوید.",
  BadRequest: "مرورگر اطلاعات اشتراک را به شکل نامعتبر فرستاد.",
  Network: "ارتباط با سرور برقرار نشد؛ ثبت اشتراک در اجرای بعدی دوباره تلاش می‌شود.",
  InternalError: "ثبت اشتراک روی سرور ناموفق بود؛ بعداً دوباره تلاش می‌شود."
}

const permissionOf = (): PushPermission =>
  isPushSupported() ? Notification.permission : "unsupported"

/**
 * Post the VAPID key **and the API origin** so the worker can resubscribe after
 * `pushsubscriptionchange` and flush a queued Done/Snooze action with no page
 * open (the session cookie rides along: same-site, `credentials: "include"`).
 */
const shareConfigWithWorker = async (publicKey: string): Promise<void> => {
  const registration = await readyRegistration()
  registration?.active?.postMessage({
    type: "tali:push-config",
    applicationServerKey: publicKey,
    apiUrl: API_URL
  })
}

/** The body of `POST /push/register`, built from the browser's subscription. */
const toRegistrationInput = (subscription: PushSubscription) => {
  const json = subscription.toJSON()
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? ""
    }
  }
}

export function PushProvider(props: ParentProps) {
  const auth = useAuth()

  const [permission, setPermission] = createSignal<PushPermission>(permissionOf())
  // Unknown until `GET /push/vapid` answers; `configured()` stays false until then.
  const [publicKey, setPublicKey] = createSignal("")
  const [subscription, setSubscription] = createSignal<PushSubscription>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [lastAction, setLastAction] = createSignal<QueuedReminderAction>()

  const supported = isPushSupported
  const secure = isSecureContext
  const installed = isInstalled
  const configured = () => publicKey().length > 0
  const subscribed = () => subscription() !== undefined

  const refreshLastAction = async () => {
    try {
      const queued = await readQueuedReminderActions()
      setLastAction(queued.at(-1))
    } catch {
      // The queue is a stub; a read failure must not break the panel.
    }
  }

  /**
   * One registration per provider instance. Boot registers for installability;
   * `refresh()` reuses that promise instead of registering again. A failed
   * attempt is forgotten so a user gesture can retry it.
   */
  let registrationTask: Promise<ServiceWorkerRegistration | undefined> | undefined
  const ensureRegistration = async (): Promise<ServiceWorkerRegistration | undefined> => {
    const pending = (registrationTask ??= registerServiceWorker())
    const registration = await pending
    if (registration === undefined) registrationTask = undefined
    return registration
  }

  const syncRegistration = async (current: PushSubscription): Promise<boolean> => {
    if (auth.status() !== "signedIn") return false
    const result = await registerPushSubscription(toRegistrationInput(current))
    if (result.ok) {
      setError(undefined)
      return true
    }
    setError(FAILURE_MESSAGE[result.code])
    return false
  }

  /**
   * Re-read browser state and, when signed in, load the VAPID key and keep the
   * server's copy of this device's subscription in step.
   *
   * The key has exactly one consumer (`POST /push/register`), so a signed-out
   * refresh stops after registering and re-reading the local subscription: the
   * worker registration is what makes the app installable, and there is nothing
   * to register server-side without a session. That keeps a cold signed-out
   * boot free of a `/push/vapid` request, and a signed-in boot pays for it once.
   */
  const refresh = async (): Promise<void> => {
    setPermission(permissionOf())

    const registration = await ensureRegistration()
    if (registration === undefined) {
      setSubscription(undefined)
      return
    }

    let current: PushSubscription | null = null
    try {
      current = await registration.pushManager.getSubscription()
    } catch {
      current = null
    }
    setSubscription(current ?? undefined)

    if (auth.status() !== "signedIn") return

    // The API owns the key (ticket #61); a build-time value still wins.
    const key = await loadVapidPublicKey()
    setPublicKey(key)
    await shareConfigWithWorker(key)

    // Keep the server in step with the browser: a reload or a rotated
    // subscription re-registers the same capability URL idempotently.
    if (current !== null) {
      await syncRegistration(current)
    }
  }

  const enable = async (): Promise<void> => {
    if (busy()) return
    if (!supported()) {
      setError("این مرورگر از اعلان‌های Web Push پشتیبانی نمی‌کند.")
      return
    }
    if (!configured()) {
      const key = await loadVapidPublicKey()
      setPublicKey(key)
      if (key === "") {
        setError("کلید عمومی VAPID روی سرور تنظیم نشده است؛ ابتدا راهنمای آزمون محلی را ببینید.")
        return
      }
    }
    if (!secure()) {
      setError("Web Push فقط در بستر امن (HTTPS یا localhost) کار می‌کند.")
      return
    }

    setBusy(true)
    setError(undefined)
    try {
      const granted = await Notification.requestPermission()
      setPermission(granted)
      if (granted !== "granted") {
        setError("اجازه‌ی اعلان داده نشد. از تنظیمات مرورگر می‌توانید آن را فعال کنید.")
        return
      }

      const registration = await ensureRegistration()
      if (registration === undefined) {
        setError("ثبت service worker ناموفق بود.")
        return
      }
      await navigator.serviceWorker.ready
      await shareConfigWithWorker(publicKey())

      const existing = await registration.pushManager.getSubscription()
      const current =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey())
        }))

      setSubscription(current)
      const ok = await syncRegistration(current)
      if (ok) await refreshLastAction()
    } catch (cause) {
      console.warn("[tali] push subscription failed", cause)
      setError("اشتراک اعلان ساخته نشد. دوباره تلاش کنید.")
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    const current = subscription()
    if (current === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await current.unsubscribe()
      setSubscription(undefined)
    } catch (cause) {
      console.warn("[tali] push unsubscribe failed", cause)
      setError("لغو اشتراک ناموفق بود.")
    } finally {
      setBusy(false)
    }
  }

  createEffect(
    () => null,
    () => {
      // Register the worker once per boot; this is also what makes the app
      // installable as a PWA. It deliberately does not load the VAPID key or
      // reconcile the subscription — a signed-out boot must stay free of
      // `/push/vapid`, and the auth effect below does that work on sign-in.
      void ensureRegistration()
      void refreshLastAction()

      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string } | undefined
        if (data?.type === "tali:reminder-action") {
          void refreshLastAction()
        } else if (data?.type === "tali:push-subscription-change") {
          void refresh()
        }
      }
      navigator.serviceWorker.addEventListener("message", onMessage)
      return () => navigator.serviceWorker.removeEventListener("message", onMessage)
    }
  )

  // The API registration needs a session: this is the *only* boot-time refresh,
  // and it runs when boot finishes signing in (cached or fresh) or after a
  // login. A signed-out boot therefore makes no `/push/vapid` request and a
  // signed-in one makes exactly one.
  createEffect(
    () => auth.status(),
    (status) => {
      if (status === "signedIn") void refresh()
    }
  )

  // Keep the visible permission in step with changes made in browser settings.
  createEffect(
    () => null,
    () => {
      if (typeof document === "undefined") return
      const onVisibility = () => {
        setPermission(permissionOf())
        if (document.visibilityState === "visible") void refreshLastAction()
      }
      document.addEventListener("visibilitychange", onVisibility)
      return () => document.removeEventListener("visibilitychange", onVisibility)
    }
  )

  const value: PushContextValue = {
    supported,
    secure,
    installed,
    configured,
    publicKey,
    permission,
    subscribed,
    busy,
    error,
    lastAction,
    enable,
    disable,
    refresh,
    subscriptionJson: () => subscription()?.toJSON()
  }

  return <PushContext value={value}>{props.children}</PushContext>
}

export const usePush = (): PushContextValue => useContext(PushContext)
