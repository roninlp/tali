import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  DispatchResponse,
  ReminderDispatchId,
  Unauthorized
} from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"
import { PreferencesService } from "./preferences-service.js"
import { ReminderService, type ReminderViewer } from "./reminder-service.js"
import { fail, json, requestUrl } from "./read-model-http.js"

/**
 * The two plain-HTTP reminder routes (ticket #60; ADR-0005 §7, §Consequences).
 *
 * They ride plain HTTP rather than RPC because their caller is not the RPC
 * client: the service worker's Done/Snooze/Dismiss action (drained by the app)
 * posts the answer, and `GET /reminders/inbox` is the app-open read of the
 * ledger. Neither is an aggregate CRUD call — the dispatch ledger is
 * server-written, so a client cannot forge a row.
 *
 * - `GET /reminders/inbox?history=1&limit=50` — the owner's unanswered
 *   dispatches (last 24 h), or the rolled-off history page.
 * - `POST /reminders/dispatches/:id/respond` — `{ response, snoozeMinutes? }`;
 *   a double tap is a no-op that returns the stored answer.
 */

/** The action body; the dispatch id is the path parameter, not a payload field. */
const RespondBody = Schema.Struct({
  response: DispatchResponse,
  snoozeMinutes: Schema.optional(Schema.Int)
})

const dispatchIdOf = (value: string | undefined): ReminderDispatchId | null => {
  if (value === undefined) return null
  const decoded = Schema.decodeUnknownOption(ReminderDispatchId)(value)
  return Option.isNone(decoded) ? null : decoded.value
}

export const ReminderRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const reminders = yield* ReminderService

    /** Resolve the cookie principal into the viewer + saved zone. */
    const principal = (
      request: HttpServerRequest.HttpServerRequest
    ): Effect.Effect<ReminderViewer, Unauthorized> =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE]
        if (token === undefined) {
          return yield* Effect.fail(new Unauthorized())
        }
        const context = yield* auth.me(token)
        if (context.householdId === null) {
          return yield* Effect.fail(new Unauthorized())
        }
        const prefs = yield* preferences.get(context.user.id, {
          timeZone: context.user.timeZone,
          weekStart: context.user.weekStart,
          digits: context.user.digits
        })
        return {
          userId: context.user.id,
          householdId: context.householdId,
          timeZone: prefs.timeZone
        } as const
      })

    /** Map the typed service outcomes onto the shared `{status,code}` envelope. */
    const unexpectedFailure = (
      error: unknown
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
      const tag = (error as { readonly _tag?: string })._tag
      switch (tag) {
        case "ReminderDispatchNotFound":
        case "ReminderNotFound":
          return fail(404, "BadRequest", "Reminder not found")
        case "ReminderForbidden":
          return fail(403, "Forbidden", "Reminder is not visible")
        case "ReminderValidationError":
          return fail(400, "BadRequest", "Reminder response is not valid")
        case "ReminderConflict":
          return fail(409, "BadRequest", "Reminder changed concurrently", true)
        case "Unauthorized":
          return fail(401, "Unauthorized", "No active session")
        default:
          return Schema.isSchemaError(error)
            ? fail(400, "BadRequest", "Malformed request")
            : fail(500, "InternalError", "Unexpected server error", true)
      }
    }

    yield* router.add(
      "GET",
      "/reminders/inbox",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const viewer = yield* principal(request)
        const url = requestUrl(request)
        const history = url.searchParams.get("history")
        const limitRaw = url.searchParams.get("limit")
        const limit = limitRaw === null ? undefined : Number(limitRaw)
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
          return yield* fail(400, "BadRequest", "limit must be an integer from 1 to 200")
        }
        const items = yield* reminders.inbox(viewer, {
          history: history === "1" || history === "true",
          limit
        })
        return yield* json(200, { items })
      }).pipe(Effect.catch(unexpectedFailure))
    )

    yield* router.add(
      "POST",
      "/reminders/dispatches/:id/respond",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const viewer = yield* principal(request)
        const params = yield* HttpRouter.params
        const dispatchId = dispatchIdOf(params.id)
        if (dispatchId === null) {
          return yield* fail(400, "BadRequest", "the dispatch id is not valid")
        }
        const body = yield* HttpServerRequest.schemaBodyJson(RespondBody)
        const result = yield* reminders.respond(viewer, {
          dispatchId,
          response: body.response,
          snoozeMinutes: body.snoozeMinutes
        })
        return yield* json(200, result)
      }).pipe(Effect.catch(unexpectedFailure))
    )
  })
)
