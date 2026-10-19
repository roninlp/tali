/**
 * Small, framework-free helpers around the service worker (ticket #20).
 *
 * Registration is best-effort: browsers without service-worker/push support
 * (or a blocked registration) must leave the rest of the app usable.
 */

export const isSecureContext = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext

export const isServiceWorkerSupported = (): boolean =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator

export const isPushSupported = (): boolean =>
  isServiceWorkerSupported() &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window

/** True when the app is running from an installed PWA window / iOS home screen. */
export const isInstalled = (): boolean => {
  if (typeof window === "undefined") return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches
}

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | undefined> => {
  if (!isServiceWorkerSupported()) return undefined
  try {
    // `/sw.js` is an unhashed public file: its scope must cover the whole app
    // (and a later push arrives at that same registration).
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  } catch (cause) {
    console.warn("[tali] service worker registration failed", cause)
    return undefined
  }
}

/** Wait for a registration to own this page (fresh installs resolve after activate). */
export const readyRegistration = async (): Promise<ServiceWorkerRegistration | undefined> => {
  if (!isServiceWorkerSupported()) return undefined
  try {
    return await navigator.serviceWorker.ready
  } catch {
    return undefined
  }
}
