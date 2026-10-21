import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { ReminderSweep } from "./reminder-sweep.js"
import { fail, json, requestUrl } from "./read-model-http.js"

/**
 * The local-only sweep trigger (ticket #61; ADR-0005 §11).
 *
 * `alchemy dev` boots the stack but runs no cron triggers, so this route drives
 * a tick by hand against the running Worker:
 *
 * ```sh
 * curl -X POST 'http://localhost:8787/dev/reminders/sweep?at=2026-10-21T07:00:00.000Z'
 * ```
 *
 * It is registered **only** when the Worker was built with dev routes enabled
 * (`makeAppLayer({ devRoutes: true })`), which `alchemy dev` sets and a deploy
 * never does — so there is no route to disable at runtime.
 *
 * `at` is the tick's nominal clock, the same value `controller.scheduledTime`
 * supplies in production; omitting it uses the real instant, which is right
 * for "what is due now" and wrong for reproducing a quiet-hours flush.
 */
export const DevReminderRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const sweep = yield* ReminderSweep

    yield* router.add(
      "POST",
      "/dev/reminders/sweep",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const at = requestUrl(request).searchParams.get("at")
        if (at !== null && !Number.isFinite(Date.parse(at))) {
          return yield* fail(400, "BadRequest", "at must be an ISO-8601 instant")
        }
        const now = at === null ? new Date().toISOString() : new Date(at).toISOString()
        const result = yield* sweep.sweep(now)
        return yield* json(200, { at: now, ...result })
      })
    )
  })
)
