import { Schema } from 'effect'

import { urlBase64ToUint8Array } from './config'
import type { PushSubscriptionJson } from './subscription'

/**
 * Small, framework-free helpers around the service worker, ported from
 * `apps/web/src/lib/push/service-worker.ts`.
 *
 * Registration is best-effort: browsers without service-worker/push support
 * (or a blocked registration) must leave the rest of the app usable.
 *
 * Scope decision: `public/sw.js` is registered at `/sw.js` with scope `/`.
 * Service worker registrations are isolated per origin (scheme + host + port),
 * so the Vite dev origin (`http://localhost:3001`) gets its own registration
 * and the deployed origin gets another. In production the app deploys on its
 * own origin, so the same root scope applies there.
 */

export const PushPermission = Schema.Literals([
  'granted',
  'denied',
  'default',
  'unsupported',
])

export type PushPermission = typeof PushPermission.Type

export const PushEnvironment = Schema.Struct({
  isSupported: Schema.Boolean,
  isSecure: Schema.Boolean,
  isInstalled: Schema.Boolean,
  permission: PushPermission,
})

export type PushEnvironment = typeof PushEnvironment.Type

export const isSecureContext = (): boolean =>
  typeof window !== 'undefined' && window.isSecureContext

export const isServiceWorkerSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator

export const isPushSupported = (): boolean =>
  isServiceWorkerSupported() &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window

/** True when the app is running from an installed PWA window / iOS home screen. */
export const isInstalled = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  const iosStandalone = Reflect.get(navigator, 'standalone') === true

  return (
    iosStandalone ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  )
}

export const permissionOf = (): PushPermission => {
  if (!isPushSupported()) {
    return 'unsupported'
  }

  return Notification.permission
}

export const detectPushEnvironment = (): PushEnvironment =>
  PushEnvironment.make({
    isSupported: isPushSupported(),
    isSecure: isSecureContext(),
    isInstalled: isInstalled(),
    permission: permissionOf(),
  })

export const registerServiceWorker = async (): Promise<
  ServiceWorkerRegistration | undefined
> => {
  if (!isServiceWorkerSupported()) {
    return undefined
  }

  try {
    return await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    })
  } catch (cause) {
    console.warn('[tali] service worker registration failed', cause)

    return undefined
  }
}

/** Wait for a registration to own this page (fresh installs resolve after activate). */
export const readyRegistration = async (): Promise<
  ServiceWorkerRegistration | undefined
> => {
  if (!isServiceWorkerSupported()) {
    return undefined
  }

  try {
    return await navigator.serviceWorker.ready
  } catch {
    return undefined
  }
}

/**
 * Post the VAPID key **and the API origin** so the worker can resubscribe after
 * `pushsubscriptionchange` and flush a queued Done/Snooze action with no page
 * open (the session cookie rides along: same-site, `credentials: "include"`).
 */
export const shareConfigWithWorker = async (
  publicKey: string,
  apiUrl: string,
): Promise<void> => {
  const registration = await readyRegistration()
  registration?.active?.postMessage({
    type: 'tali:push-config',
    applicationServerKey: publicKey,
    apiUrl,
  })
}

export const requestNotificationPermission =
  async (): Promise<PushPermission> => {
    if (!isPushSupported()) {
      return 'unsupported'
    }

    try {
      return await Notification.requestPermission()
    } catch {
      return 'denied'
    }
  }

const subscriptionJsonOf = (
  subscription: PushSubscription,
): PushSubscriptionJson => {
  const json = subscription.toJSON()

  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
    },
  }
}

export const findSubscription = async (): Promise<
  PushSubscriptionJson | undefined
> => {
  const registration = await readyRegistration()

  if (registration === undefined) {
    return undefined
  }

  try {
    const subscription = await registration.pushManager.getSubscription()

    return subscription === null ? undefined : subscriptionJsonOf(subscription)
  } catch {
    return undefined
  }
}

/**
 * Ask for permission, subscribe this device with the server's VAPID key, and
 * hand the subscription back. Sharing the config with the worker is part of
 * subscribing so a rotation can resubscribe without a page open.
 */
export const subscribeThisDevice = async (
  publicKey: string,
  apiUrl: string,
): Promise<PushSubscriptionJson | undefined> => {
  const registration = await registerServiceWorker()

  if (registration === undefined) {
    return undefined
  }

  await navigator.serviceWorker.ready
  await shareConfigWithWorker(publicKey, apiUrl)

  const existing = await registration.pushManager.getSubscription()

  if (existing !== null) {
    return subscriptionJsonOf(existing)
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })

  return subscriptionJsonOf(subscription)
}

export const unsubscribeThisDevice = async (): Promise<boolean> => {
  const registration = await readyRegistration()

  if (registration === undefined) {
    return false
  }

  try {
    const subscription = await registration.pushManager.getSubscription()

    return subscription === null ? true : await subscription.unsubscribe()
  } catch {
    return false
  }
}
