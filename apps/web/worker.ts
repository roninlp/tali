/**
 * The deployed web Worker: one origin for the SPA and the api Worker.
 *
 * `apps/web` builds to static assets, and Cloudflare routes `/api/*` through
 * this script before the asset layer (see `infra/alchemy.run.ts`). The script
 * strips the `/api` prefix and forwards the request to the api Worker over a
 * service binding, so the browser only ever talks to one origin:
 *
 * - the session cookie is same-origin, so `SameSite=Lax` is enough and the
 *   api's CORS allowlist stays inert in production;
 * - the RPC client talks to a relative `/api` that resolves against whatever
 *   hostname the deployment has (`workers.dev`, a stage URL, or a custom
 *   domain) instead of a build-time absolute URL;
 * - the service worker and Web Push subscriptions share that origin too.
 *
 * Local development never runs this file: `alchemy dev` starts Vite on :3000
 * and the SPA calls the api Worker on :8787 directly (CORS, allowed origin).
 */
interface Env {
  /** Service binding to the api Worker (declared in `infra/alchemy.run.ts`). */
  API: { fetch(request: Request): Promise<Response> }
  /** The SPA's static assets, provided by Cloudflare's asset layer. */
  ASSETS: { fetch(request: Request): Promise<Response> }
}

const API_PREFIX = "/api"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      const target = new URL(request.url)
      target.pathname = url.pathname.slice(API_PREFIX.length) || "/"
      // Passing the original request as the init keeps method, headers, body
      // and the caller's `cf` metadata; only the URL changes.
      return env.API.fetch(new Request(target, request))
    }

    return env.ASSETS.fetch(request)
  }
}
