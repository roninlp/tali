import { Effect } from 'effect'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import {
  isSafePushEndpoint,
  PushSubscription,
  PushSubscriptionInput,
} from '@tali/domain'
import { PushSubscriptionRepo } from '@tali/sql'
import { AuthService } from './auth-service.js'
import { fail, json, unexpectedFailure } from './http-envelope.js'
import { sessionResolver } from './principal.js'
import { PushConfig } from './push-gateway.js'

/**
 * Web Push registration and identity (tickets #20, #61).
 *
 * - `POST /push/register` stores the browser's `PushSubscription` in D1. The
 *   per-minute sweep reads those rows; nothing is sent from this route.
 * - `GET /push/vapid` serves the public key the browser subscribes with, so the
 *   server is the single source of truth for its own VAPID identity.
 *
 * They ride plain HTTP (like auth/sync) because the browser sends the session
 * cookie; the response body is the shared `ErrorEnvelope` on failure.
 */

const optionalIso = (epochMs: number | null): string | null =>
  epochMs === null ? null : new Date(epochMs).toISOString()

export const PushRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const subscriptions = yield* PushSubscriptionRepo
    const vapid = yield* PushConfig

    /**
     * The subscription's `applicationServerKey` (ticket #61).
     *
     * The server is the source of truth for its own VAPID identity, so a local
     * stack works without copying a key into `apps/web-foldkit/.env.local`, and a
     * build-time key can never disagree with the one that signs the pushes
     * (a mismatch makes every subscription silently reject with 403).
     * Unauthenticated: the public key and subject are public by design
     * (RFC 8292 §3.2).
     */
    yield* router.add(
      'GET',
      '/push/vapid',
      json(200, {
        publicKey: vapid?.publicKey ?? null,
        subject: vapid?.subject ?? null,
      }),
    )

    yield* router.add(
      'POST',
      '/push/register',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const context = yield* sessionResolver(auth)(request)
        const input = yield* HttpServerRequest.schemaBodyJson(
          PushSubscriptionInput,
        )
        // The endpoint is a capability URL this Worker will POST to. Reject
        // anything that is not a public HTTPS origin here, so a bad row never
        // reaches the sweep (the gateway re-checks stored rows).
        if (!isSafePushEndpoint(input.endpoint)) {
          return yield* fail(
            400,
            'BadRequest',
            'the push endpoint must be a public HTTPS URL',
          )
        }
        const now = new Date().toISOString()

        yield* subscriptions
          .upsert(
            PushSubscription.insert.make({
              userId: context.user.id,
              endpoint: input.endpoint,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              expirationTime: optionalIso(input.expirationTime),
              userAgent: request.headers['user-agent'] ?? null,
              createdAt: now,
              updatedAt: now,
            }),
          )
          .pipe(Effect.orDie)

        return yield* json(201, { ok: true })
      }).pipe(
        Effect.catchTags(
          {
            Unauthorized: () => fail(401, 'Unauthorized', 'No active session'),
          },
          unexpectedFailure('Malformed push subscription'),
        ),
      ),
    )
  }),
)
