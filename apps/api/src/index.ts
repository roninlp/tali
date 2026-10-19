import { Layer, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import { AppLayer } from "./http-layer.js"

/**
 * Cloudflare Worker entrypoint.
 *
 * Builds one D1 layer per request (D1 has no connection pool — the binding is
 * cheap) and serves the Effect HTTP app (RPC + auth + sync) as a Web fetch
 * handler. The layer maps snake_case columns ↔ camelCase model fields so
 * `SqlModel` repositories and hand-written `SELECT *` queries agree on names.
 *
 * Cross-origin dev: the web app runs on :3000 and this Worker on :8787, so the
 * response carries CORS headers with credentials (the session cookie). In
 * production the Worker is reverse-proxied on the web origin and CORS is inert.
 */
interface Env {
  DB: D1Database
  /** The web origin allowed to call the API cross-origin (defaults to the Vite dev server). */
  WEB_ORIGIN?: string
}

const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

const allowedOrigin = (request: Request, env: Env): string | undefined => {
  const origin = request.headers.get("Origin")
  if (origin === null) return undefined
  return origin === (env.WEB_ORIGIN ?? DEV_ORIGINS[0]) || DEV_ORIGINS.includes(origin)
    ? origin
    : undefined
}

const corsHeaders = (origin: string): Record<string, string> => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  // Effect's HTTP client adds B3/trace propagation headers to requests, and the
  // RPC transport posts ndjson; both must pass the browser's preflight.
  "access-control-allow-headers": "content-type, authorization, traceparent, b3",
  "access-control-max-age": "600",
  vary: "origin"
})

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = allowedOrigin(request, env)

    // Browser preflight: answer before the router sees it.
    if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      return origin === undefined
        ? new Response(null, { status: 403 })
        : new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    const app = AppLayer.pipe(
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
      if (origin === undefined) return response

      // Clone so the (possibly streaming) body survives; `Set-Cookie` is kept.
      const withCors = new Response(response.body, response)
      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        withCors.headers.set(key, value)
      }
      return withCors
    } finally {
      await dispose()
    }
  }
}
