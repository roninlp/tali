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
 */
interface Env {
  DB: D1Database
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
      return await handler(request)
    } finally {
      await dispose()
    }
  }
}
