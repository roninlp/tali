import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { D1Client } from "@effect/sql-d1"
import { AppLayer } from "./http-layer.js"

/**
 * Cloudflare Worker entrypoint.
 *
 * Builds one D1 layer per request (D1 has no connection pool — the binding is
 * cheap) and serves the Effect HTTP app (RPC + sync) as a Web fetch handler.
 */
interface Env {
  DB: D1Database
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = AppLayer.pipe(Layer.provide(D1Client.layer({ db: env.DB })))
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })
    try {
      return await handler(request)
    } finally {
      await dispose()
    }
  }
}
