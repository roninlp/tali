/**
 * The deployed web Worker: one origin for the SPA and the api Worker.
 *
 * `apps/web-foldkit` builds to static assets, and Cloudflare routes `/api/*`
 * through this script before the asset layer (see `infra/alchemy.run.ts`). The
 * script strips the `/api` prefix and forwards the request to the api Worker
 * over a service binding, so the browser only ever talks to one origin:
 *
 * - the session cookie is same-origin, so `SameSite=Lax` is enough and the
 *   api's CORS allowlist stays inert in production;
 * - the RPC client talks to a relative `/api` that resolves against whatever
 *   hostname the deployment has (`workers.dev`, a stage URL, or a custom
 *   domain) instead of a build-time absolute URL;
 * - the service worker and Web Push subscriptions share that origin too.
 *
 * Local development never runs this file: `alchemy dev` starts Vite on :3001
 * and the SPA proxies the api routes to the Worker on :8787.
 */
interface Env {
  /** Service binding to the api Worker (declared in `infra/alchemy.run.ts`). */
  API: { fetch(request: Request): Promise<Response> }
  /** The SPA's static assets, provided by Cloudflare's asset layer. */
  ASSETS: { fetch(request: Request): Promise<Response> }
}

const API_PREFIX = '/api'
const ASSETS_PREFIX = '/assets/'

/**
 * Served when a client asks for an asset that the current deployment no longer
 * has. A browser (or installed PWA) that kept the previous index.html asks for
 * the previous asset hashes; the asset layer answers a missing path with the
 * SPA shell as `text/html`, which the browser refuses to execute and leaves a
 * blank page. This tiny module clears the stale caches/service worker once, then
 * reloads into the current shell. The attempt counter prevents a reload loop.
 */
const RECOVERY_MODULE = `;(async () => {
  const key = 'tali:asset-heal'
  const attempts = Number(sessionStorage.getItem(key) || '0')
  if (attempts >= 2) return
  sessionStorage.setItem(key, String(attempts + 1))
  try {
    if ('caches' in self) {
      const keys = await caches.keys()
      await Promise.all(keys.map(name => caches.delete(name)))
    }
  } catch {}
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map(registration => registration.unregister()))
    }
  } catch {}
  location.reload()
})()
`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (
      url.pathname === API_PREFIX ||
      url.pathname.startsWith(`${API_PREFIX}/`)
    ) {
      const target = new URL(request.url)
      target.pathname = url.pathname.slice(API_PREFIX.length) || '/'

      // Passing the original request as the init keeps method, headers, body
      // and the caller's `cf` metadata; only the URL changes.
      return env.API.fetch(new Request(target, request))
    }

    if (url.pathname.startsWith(ASSETS_PREFIX)) {
      const response = await env.ASSETS.fetch(request)
      const contentType = response.headers.get('content-type') ?? ''

      // A missing asset falls back to the SPA shell. Hand the old bundle a
      // module that heals the cache instead of letting the browser execute
      // HTML as JavaScript.
      if (response.ok && contentType.includes('text/html')) {
        return new Response(RECOVERY_MODULE, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      }

      return response
    }

    return env.ASSETS.fetch(request)
  },
}
