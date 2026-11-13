import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vite-plus/test'
import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { uuidV7 } from '@tali/domain'
import { makeAppLayer } from '../src/http-layer.js'
import { FakeD1 } from './fake-d1.js'
import { seedHousehold, seedUser } from './fixtures/seed.js'
import { d1Layer, openMigratedDatabase } from './harness.js'
import { makeTestVapidKeys } from './vapid-fixture.js'

/**
 * The two HTTP surfaces ticket #61 adds: the local-only sweep trigger
 * (ADR-0005 §11) and the VAPID public key the browser subscribes with.
 *
 * These are the only real request-level tests in the api suite — the dev
 * trigger's whole value is that it is *not registered* in a deployed Worker,
 * and that is a property of the layer, not of a service call.
 */

/** Generated per run: no private key material is committed to the repository. */
const VAPID = {
  ...makeTestVapidKeys(),
  subject: 'mailto:dev@tali.local',
}

const FIRE_AT = '2026-10-21T06:00:00.000Z'
const USER = 'user-route'
const HOUSEHOLD = 'household-route'

const makeDatabase = () => {
  const db = openMigratedDatabase()
  seedUser(db, {
    id: USER,
    email: 'route@example.com',
    displayName: 'route',
    timeZone: 'UTC',
    now: FIRE_AT,
  })
  seedHousehold(db, {
    id: HOUSEHOLD,
    creator: USER,
    inviteCode: 'route-invite',
    name: 'خانه',
    now: FIRE_AT,
  })

  const id = uuidV7()
  db.prepare(
    `INSERT INTO reminders
      (id, type, title, note, owner_id, household_id, visibility, color, kind, tier,
       repeat, offset_minutes, fire_at, link_type, link_id, silenced_until, time_zone,
       created_at, updated_at, version, deleted_at)
     VALUES (?, 'reminder', 'دارو', NULL, ?, ?, 'shared', NULL,
             'medication', 'critical', ?, 0, ?, 'none', NULL, NULL, 'UTC', ?, ?, 1, NULL)`,
  ).run(
    id,
    USER,
    HOUSEHOLD,
    JSON.stringify({ _tag: 'once' }),
    FIRE_AT,
    FIRE_AT,
    FIRE_AT,
  )
  return { db, reminderId: id }
}

const handlerFor = (
  db: DatabaseSync,
  options: Parameters<typeof makeAppLayer>[0],
) => {
  const d1 = d1Layer(new FakeD1(db))
  return HttpRouter.toWebHandler(
    makeAppLayer(options).pipe(Layer.provide(d1)),
    { disableLogger: true },
  )
}

describe('POST /dev/reminders/sweep', () => {
  it('drives one tick at an explicit clock when dev routes are enabled', async () => {
    const { db } = makeDatabase()
    const { handler, dispose } = handlerFor(db, {
      vapid: VAPID,
      devRoutes: true,
    })
    try {
      const response = await handler(
        new Request(
          'http://localhost/dev/reminders/sweep?at=2026-10-21T06:00:00.000Z',
          {
            method: 'POST',
          },
        ),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toMatchObject({
        at: FIRE_AT,
        claimed: 1,
        // No VAPID private key issue here — the keys are configured; the owner
        // simply has no push subscription, so the dispatch is inbox-only.
        pushed: 0,
        expired: 1,
      })
      const dispatch = db
        .prepare('SELECT push_outcome, scheduled_for FROM reminder_dispatches')
        .get() as {
        readonly push_outcome: string
        readonly scheduled_for: string
      }
      expect(dispatch).toEqual({
        push_outcome: 'expired',
        scheduled_for: FIRE_AT,
      })
    } finally {
      await dispose()
    }
  })

  it('is not registered at all in the default (deployable) app', async () => {
    const { db } = makeDatabase()
    const { handler, dispose } = handlerFor(db, { vapid: VAPID })
    try {
      const response = await handler(
        new Request(
          'http://localhost/dev/reminders/sweep?at=2026-10-21T06:00:00.000Z',
          {
            method: 'POST',
          },
        ),
      )
      expect(response.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it('rejects a malformed `at` instead of guessing a clock', async () => {
    const { db } = makeDatabase()
    const { handler, dispose } = handlerFor(db, {
      vapid: VAPID,
      devRoutes: true,
    })
    try {
      const response = await handler(
        new Request('http://localhost/dev/reminders/sweep?at=soon', {
          method: 'POST',
        }),
      )
      expect(response.status).toBe(400)
    } finally {
      await dispose()
    }
  })
})

describe('GET /push/vapid', () => {
  it('serves the public key and subject the browser subscribes with', async () => {
    const { db } = makeDatabase()
    const { handler, dispose } = handlerFor(db, { vapid: VAPID })
    try {
      const response = await handler(new Request('http://localhost/push/vapid'))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        publicKey: VAPID.publicKey,
        subject: VAPID.subject,
      })
    } finally {
      await dispose()
    }
  })

  it('answers null when this environment has no VAPID keys', async () => {
    const { db } = makeDatabase()
    const { handler, dispose } = handlerFor(db, {})
    try {
      const response = await handler(new Request('http://localhost/push/vapid'))
      expect(await response.json()).toEqual({ publicKey: null, subject: null })
    } finally {
      await dispose()
    }
  })
})
