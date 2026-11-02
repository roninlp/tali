import { Array, Data, Effect, Option, Schema } from 'effect'

import { API_URL } from '../config'

/**
 * The page half of the Done/Snooze wiring (tickets #20, #61), ported from
 * `apps/web/src/lib/push/notification-actions.ts`.
 *
 * The service worker cannot own the signed-in session's UI state, so on a
 * notification action it appends a durable record to this device-local queue
 * and tries to flush it immediately. This module is the **page drain**: on
 * boot, on `visibilitychange`, and when the worker messages that a tap landed,
 * the app reads the queue and posts each answer to the existing
 * `POST /reminders/dispatches/:id/respond` route.
 *
 * `id` in the queue is the **dispatch id**, not the reminder id: one fire is
 * one ledger row and one answer, and a snoozed occurrence must not answer the
 * earlier one. A record is deleted only after the server accepted it (or said
 * the dispatch does not exist), so an offline tap survives until the next open.
 *
 * Keep the database/store names in sync with `public/sw.js`.
 */

export const PUSH_DB_NAME = 'tali.push.v1'
export const PUSH_ACTIONS_STORE = 'actions'

export const QueuedReminderAction = Schema.Struct({
  /** IndexedDB auto-increment key (absent on freshly written records). */
  seq: Schema.optional(Schema.Int),
  /** The ledger row the notification represented. */
  dispatchId: Schema.String,
  action: Schema.Literals(['done', 'snooze']),
  /** Preset minutes for a `snooze` tap (the notification's default is 10). */
  snoozeMinutes: Schema.optional(Schema.Int),
  /** ISO-8601 timestamp written by the service worker. */
  at: Schema.String,
})
export type QueuedReminderAction = typeof QueuedReminderAction.Type

/** The `tali:reminder-action` message the worker broadcasts after a tap. */
export const ReminderActionMessage = Schema.Struct({
  type: Schema.Literal('tali:reminder-action'),
  dispatchId: Schema.String,
  action: Schema.Literals(['done', 'snooze']),
  snoozeMinutes: Schema.optional(Schema.Int),
  at: Schema.String,
})
export type ReminderActionMessage = typeof ReminderActionMessage.Type

const decodeQueuedAction = Schema.decodeUnknownOption(QueuedReminderAction)

class PushQueueError extends Data.TaggedError('PushQueueError')<{
  readonly message: string
}> {}

const queueError = (cause: unknown): PushQueueError =>
  new PushQueueError({
    message: cause instanceof Error ? cause.message : 'push queue unavailable',
  })

const openDatabase = (): Effect.Effect<IDBDatabase, PushQueueError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalThis.indexedDB.open(PUSH_DB_NAME, 1)

        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(PUSH_ACTIONS_STORE)) {
            db.createObjectStore(PUSH_ACTIONS_STORE, {
              keyPath: 'seq',
              autoIncrement: true,
            })
          }
        }

        request.onsuccess = () => {
          const db = request.result
          db.onversionchange = () => db.close()
          resolve(db)
        }

        request.onerror = () =>
          reject(request.error ?? new Error('Could not open the push queue'))
      }),
    catch: queueError,
  })

const withDatabase = <A>(
  run: (db: IDBDatabase) => Promise<A>,
): Effect.Effect<A, PushQueueError> =>
  Effect.acquireUseRelease(
    openDatabase(),
    db =>
      Effect.tryPromise({
        try: () => run(db),
        catch: queueError,
      }),
    db => Effect.sync(() => db.close()),
  )

const readRows = (db: IDBDatabase): Promise<ReadonlyArray<unknown>> =>
  new Promise((resolve, reject) => {
    const request = db
      .transaction(PUSH_ACTIONS_STORE, 'readonly')
      .objectStore(PUSH_ACTIONS_STORE)
      .getAll()

    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Could not read the push queue'))
  })

/** Every queued notification response, oldest first. Non-destructive. */
export const readQueuedReminderActions: Effect.Effect<
  ReadonlyArray<QueuedReminderAction>
> = Effect.gen(function* () {
  if (globalThis.indexedDB === undefined) {
    return []
  }

  const rows = yield* withDatabase(readRows)
  return Array.getSomes(Array.map(rows, row => decodeQueuedAction(row)))
}).pipe(Effect.catch(() => Effect.succeed([])))

const deleteQueuedReminderAction = (seq: number): Effect.Effect<boolean> =>
  withDatabase(
    db =>
      new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(PUSH_ACTIONS_STORE, 'readwrite')
        transaction.objectStore(PUSH_ACTIONS_STORE).delete(seq)
        transaction.oncomplete = () => resolve(true)
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Could not drain the queue'))
      }),
  ).pipe(Effect.catch(() => Effect.succeed(false)))

export interface FlushResult {
  /** Records the caller's `send` accepted (and that are now deleted). */
  readonly drained: number
  /** Records left for the next open (network/server failure). */
  readonly remaining: number
}

/**
 * Drain the queue through `send`.
 *
 * `send` returns `true` when the record is finished with (accepted, or
 * permanently unanswerable) and `false` to keep it.
 */
export const flushQueuedReminderActions = (
  send: (record: QueuedReminderAction) => Effect.Effect<boolean>,
): Effect.Effect<FlushResult> =>
  Effect.gen(function* () {
    const queued = yield* readQueuedReminderActions

    const drained = yield* Effect.reduce(
      queued,
      () => 0,
      (count, record) =>
        Option.match(Option.fromNullishOr(record.seq), {
          onNone: () => Effect.succeed(count),
          onSome: seq =>
            Effect.gen(function* () {
              const handled = yield* send(record)

              if (!handled) {
                return count
              }

              const deleted = yield* deleteQueuedReminderAction(seq)
              return deleted ? count + 1 : count
            }),
        }),
    )

    return { drained, remaining: queued.length - drained }
  })

/**
 * Post one queued answer to the respond route. Treats a 2xx, `404` and `400`
 * as finished with: the dispatch is answered, gone, or permanently
 * unanswerable. A network/5xx/401 failure keeps the record for the next open.
 */
export const respondToDispatch = (
  record: QueuedReminderAction,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const maybeResponse = yield* Effect.option(
      Effect.tryPromise({
        try: () =>
          fetch(
            `${API_URL}/reminders/dispatches/${encodeURIComponent(record.dispatchId)}/respond`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                record.action === 'snooze'
                  ? {
                      response: 'snooze',
                      snoozeMinutes: record.snoozeMinutes ?? 10,
                    }
                  : { response: record.action },
              ),
            },
          ),
        catch: () => undefined,
      }),
    )

    return Option.match(maybeResponse, {
      onNone: () => false,
      onSome: response =>
        response.ok || response.status === 404 || response.status === 400,
    })
  })
