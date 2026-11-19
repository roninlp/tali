import * as Cloudflare from '@alchemy.run/cloudflare'
import { WorkerEnvironment } from '@alchemy.run/cloudflare'
import * as DomainCloudflare from '@alchemy.run/domain/Cloudflare'
import { Effect, Layer, Option } from 'effect'
import * as HttpHeaders from 'effect/http/Headers'
import { HttpServerRequest } from 'effect/http'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { isOnTime } from '@tali/domain/reminder-policy'
import {
  AnswerDone,
  DeleteReminder,
  DeleteReminderRequest,
  Dismiss,
  ReminderOwner,
  RespondRequest,
  SilenceReminder,
  SilenceRequest,
  Snooze,
  SweepRequest,
  type AnswerReply,
} from '@tali/reminder-domain'
import { Reminders, RemindersHandlers } from '@tali/reminder-domain'
import {
  DispatchLedgerStoreLive,
  PushServiceLive,
  PushSubscriptionStoreLive,
  ReminderScheduleStoreLive,
} from './adapters.js'
import { runTick } from './tick.js'

/**
 * The reminders Worker — the firing model's host (ADR-0005's successor).
 *
 * Every aggregate instance, projection and policy is a Durable Object
 * declared by `DomainCloudflare.layerDurableObjects()`; nothing here wires a
 * binding or writes a class. The api Worker stays the clock (its cron posts
 * one `SweepRequest` per tick) and the auth surface; this Worker has no
 * public URL and answers only the api's service binding, checked against a
 * shared secret so even an accidental public route is inert.
 *
 * `alchemy dev` runs this Worker with its Durable Objects on the local
 * workerd, so the whole stack boots exactly as it deploys.
 */

interface Env {
  readonly DB: D1Database
  /** The api's shared internal secret; no request without it is served. */
  readonly INTERNAL_TOKEN?: string
  readonly VAPID_PRIVATE_KEY?: string
  readonly VAPID_PUBLIC_KEY?: string
  readonly VAPID_SUBJECT?: string
}

/** One Layer: the hosted model, its D1 adapters, and the push transport. */
const RemindersLive = Reminders.layer(RemindersHandlers).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      DispatchLedgerStoreLive,
      ReminderScheduleStoreLive,
      PushSubscriptionStoreLive,
    ),
  ),
  Layer.provide(
    Layer.mergeAll(DomainCloudflare.layerDurableObjects(), PushServiceLive),
  ),
)

/** The stored answer, for the respond route's double-tap contract. */
const storedAnswerOf =
  (owners: typeof ReminderOwner.Service) =>
  (dispatchId: string): Effect.Effect<AnswerReply> =>
    Effect.gen(function* () {
      const state = yield* owners.get(dispatchId as never)
      const dispatch = state.dispatches[dispatchId]
      if (dispatch === undefined)
        return { dispatch: null, child: null, onTime: false } as never
      const childId = state.snoozeChildren[dispatchId]
      return {
        dispatch,
        child:
          childId === undefined ? null : (state.dispatches[childId] ?? null),
        onTime: isOnTime(dispatch),
      }
    })

export default class TaliRemindersWorker extends Cloudflare.Worker<TaliRemindersWorker>()(
  'TaliReminders',
  { main: (import.meta as unknown as { readonly url: string }).url },
  Effect.gen(function* () {
    const owners = yield* ReminderOwner
    const env = (yield* WorkerEnvironment) as unknown as Env
    const storedAnswer = storedAnswerOf(owners)

    /** The shared-secret guard: the binding is private, this is the bolt. */
    const authorized = (presented: string | undefined): boolean =>
      (env.INTERNAL_TOKEN ?? '') !== '' && presented === env.INTERNAL_TOKEN

    /** One answer command; the double tap is answered from the ledger. */
    const respond = (
      body: RespondRequest,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      Effect.gen(function* () {
        const command =
          body.response === 'done'
            ? new AnswerDone({ dispatchId: body.dispatchId })
            : body.response === 'dismiss'
              ? new Dismiss({ dispatchId: body.dispatchId })
              : new Snooze({
                  dispatchId: body.dispatchId,
                  minutes: body.snoozeMinutes ?? 0,
                })
        const receipt = yield* owners.send(body.ownerId as never, command)
        return yield* Effect.orDie(HttpServerResponse.json(receipt.reply))
      }).pipe(
        // A double tap returns the stored answer, not an error.
        Effect.catchTag('AlreadyAnswered', () =>
          Effect.flatMap(storedAnswer(body.dispatchId), answer =>
            Effect.orDie(HttpServerResponse.json(answer)),
          ),
        ),
        Effect.catchTag('DispatchNotFound', rejection =>
          Effect.orDie(HttpServerResponse.json(rejection, { status: 404 })),
        ),
        Effect.catchTag('SnoozeMinutesNotPreset', rejection =>
          Effect.orDie(HttpServerResponse.json(rejection, { status: 400 })),
        ),
        Effect.orDie,
      )

    /** The write path's change of mind, idempotent per row version. */
    const silence = (body: SilenceRequest) =>
      Effect.flatMap(
        owners.send(
          body.ownerId as never,
          new SilenceReminder({
            reminderId: body.reminderId,
            until: body.until,
          }),
          { commandId: `silence:${body.reminderId}:v${body.version}` },
        ),
        () => Effect.orDie(HttpServerResponse.json({ ok: true })),
      )

    const removeReminder = (body: DeleteReminderRequest) =>
      Effect.flatMap(
        owners.send(
          body.ownerId as never,
          new DeleteReminder({ reminderId: body.reminderId }),
          { commandId: `delete:${body.reminderId}:v${body.version}` },
        ),
        () => Effect.orDie(HttpServerResponse.json({ ok: true })),
      )

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = Effect.gen(function* () {
          const presented = Option.getOrUndefined(
            HttpHeaders.get('x-internal-token')(request.headers),
          )
          if (request.method !== 'POST' || !authorized(presented)) {
            return HttpServerResponse.text('Forbidden', { status: 403 })
          }
          const path = new URL(request.url, 'http://localhost').pathname
          if (path === '/internal/sweep') {
            const body = yield* HttpServerRequest.schemaBodyJson(SweepRequest)
            const tally = yield* runTick(owners, body)
            return yield* Effect.orDie(HttpServerResponse.json(tally))
          }
          if (path === '/internal/respond') {
            const body = yield* HttpServerRequest.schemaBodyJson(RespondRequest)
            return yield* respond(body)
          }
          if (path === '/internal/silence') {
            const body = yield* HttpServerRequest.schemaBodyJson(SilenceRequest)
            return yield* silence(body)
          }
          if (path === '/internal/delete') {
            const body = yield* HttpServerRequest.schemaBodyJson(
              DeleteReminderRequest,
            )
            return yield* removeReminder(body)
          }
          return HttpServerResponse.text('Not Found', { status: 404 })
        })
        return yield* route.pipe(
          // The route reads the already-yielded request; what is left of the
          // error channel (a malformed body, a failed JSON encode) dies
          // into the runtime's 500, after each route caught its own
          // rejections.
          Effect.provideServiceEffect(
            HttpServerRequest.HttpServerRequest,
            Effect.succeed(request),
          ),
          Effect.orDie,
        )
      }),
    }
  }).pipe(Effect.provide(RemindersLive)),
) {}
