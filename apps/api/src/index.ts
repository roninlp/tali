import { Layer, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import { makeAppLayer } from "./http-layer.js"
import { vapidConfigOf } from "./push-gateway.js"
import { runReminderSweep } from "./reminder-sweep-runner.js"

/**
 * Cloudflare Worker entrypoint.
 *
 * Builds one D1 layer per request (D1 has no connection pool — the binding is
 * cheap) and serves the Effect HTTP app (RPC + auth + sync) as a Web fetch
 * handler. The layer maps snake_case columns ↔ camelCase model fields so
 * `SqlModel` repositories and hand-written `SELECT *` queries agree on names.
 *
 * Cross-origin dev: the web app runs on :3000 and this Worker on :8787, so the
 * response carries CORS headers with credentials (the session cookie). That
 * allowlist is *only* active when the Worker itself is serving a local request
 * (or `WEB_ORIGIN` names an explicit origin); a deployed Worker never echoes a
 * localhost origin. In production the Worker is reverse-proxied on the web
 * origin and CORS is inert.
 */
interface Env {
  DB: D1Database
  /** Explicit web origin allowed to call the API cross-origin. Overrides the dev fallback. */
  WEB_ORIGIN?: string
  /** VAPID identity (RFC 8292). The private key is a secret binding. */
  VAPID_PRIVATE_KEY?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_SUBJECT?: string
  /** `1` only when the stack was started by `alchemy dev` (#61's sweep trigger). */
  DEV_ROUTES?: string
}

/** The Vite dev server's origin. `127.0.0.1` is deliberately absent: it is a
 * different site from `localhost` for cookies (`SameSite=Lax`), so a page
 * served there could never send the session anyway. */
const DEV_ORIGIN = "http://localhost:3000"

/** Is this Worker itself serving a local dev request? */
const isLocalRequest = (request: Request): boolean => {
  const hostname = new URL(request.url).hostname
  return hostname === "localhost" || hostname === "127.0.0.1"
}

const allowedOrigin = (request: Request, env: Env): string | undefined => {
  const origin = request.headers.get("Origin")
  if (origin === null) return undefined
  const allowed = env.WEB_ORIGIN !== undefined
    ? [env.WEB_ORIGIN]
    : isLocalRequest(request)
      ? [DEV_ORIGIN]
      : []
  return allowed.includes(origin) ? origin : undefined
}

const corsHeaders = (origin: string): Record<string, string> => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  // Effect's HTTP client adds B3/trace propagation headers to requests, and the
  // RPC transport posts ndjson; both must pass the browser's preflight.
  // `if-none-match` is not a CORS-safelisted request header, so a cross-origin
  // `/today` revalidation carrying the stored ETag needs it allowed explicitly.
  "access-control-allow-headers":
    "content-type, authorization, traceparent, b3, if-none-match",
  // `etag` is not a CORS-safelisted response header either: without this the
  // browser hands `fetch` a null ETag on the :3000 → :8787 dev split and the
  // dashboard silently never revalidates (200 every time, no 304).
  "access-control-expose-headers": "etag",
  "access-control-max-age": "600"
})

const preflightResponse = (origin: string): Response => {
  const headers = new Headers(corsHeaders(origin))
  headers.append("vary", "origin")
  return new Response(null, { status: 204, headers })
}

const withCors = (response: Response, origin: string): Response => {
  // Clone so the (possibly streaming) body survives; `Set-Cookie` is kept.
  const out = new Response(response.body, response)
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    out.headers.set(key, value)
  }
  out.headers.append("vary", "origin")
  return out
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = allowedOrigin(request, env)

    // Browser preflight: answer before the router sees it.
    if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      return origin === undefined ? new Response(null, { status: 403 }) : preflightResponse(origin)
    }

    const app = makeAppLayer({
      vapid: vapidConfigOf(env),
      // `alchemy dev` sets this; a deployed Worker has no such binding, so the
      // local sweep trigger is not registered at all (ADR-0005 §11).
      devRoutes: env.DEV_ROUTES === "1"
    }).pipe(
      Layer.provide(
        D1Client.layer({
          db: env.DB,
          transformQueryNames: Str.camelToSnake,
          transformResultNames: Str.snakeToCamel
        })
      )
    )
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })
    try {
      const response = await handler(request)
      return origin === undefined ? response : withCors(response, origin)
    } finally {
      await dispose()
    }
  },

  /**
   * The per-minute reminder sweep (ticket #61; ADR-0005).
   *
   * Cron put us here, so the clock is `controller.scheduledTime` — the nominal
   * minute boundary — never `Date.now()`: two invocations for the same minute
   * compute the same window and converge on the same claim. The sweep is a
   * catch-up query, so a late, skipped or repeated tick loses nothing.
   *
   * Errors are caught and logged rather than rethrown: a failed tick is not
   * recoverable by Cloudflare's retry (the next minute's query sees the same
   * rows), and a throw would only mark the invocation failed.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const now = new Date(controller.scheduledTime).toISOString()
    ctx.waitUntil(
      runReminderSweep(env, now)
        .then((result) => {
          console.log(JSON.stringify({ event: "reminder.sweep", at: now, ...result }))
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: "reminder.sweep.failed",
              at: now,
              message: error instanceof Error ? error.message : String(error)
            })
          )
        })
    )
  }
}
