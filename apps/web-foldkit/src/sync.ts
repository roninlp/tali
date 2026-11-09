import {
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  Queue,
  Random,
  Schema,
  Stream,
} from 'effect'
import {
  Command,
  ManagedResource,
  Submodel,
  Subscription,
  Update,
} from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  FAILED_REFRESH_INTERVAL_MS,
  SyncRejected,
  createSyncEngine,
  syncDelayMs,
} from '@tali/sync-client'

import { syncTransport } from './lib/sync-transport'
import {
  emptyMirrorSnapshot,
  pendingKeysOf,
  readMirrorSnapshot,
} from './mirror'
import { MirrorSnapshot } from './mirror'
import {
  LocalStoreResource,
  closeStore,
  openStore,
  storeErrorMessage,
} from './sync/local-store'
import type { LocalStoreService } from './sync/local-store'
import { syncStatusView } from './ui/sync-status'
import type { SyncStatusKind } from './ui/sync-status'

export type { LocalStoreService } from './sync/local-store'

/**
 * The local-first sync Submodel, ported from the legacy app's local-store
 * provider, sync runner, cadence and status pill.
 *
 * The Model holds the snapshots the views read (task rows, outbox counts,
 * connectivity, failures). IndexedDB lives behind the `LocalStore` managed
 * resource, the engine runs in Commands, and the wake rhythm is a
 * Subscription. Auth stays on its own plain-HTTP client; the sync transport is
 * the only place here that touches the network.
 */

// MODEL

export const StoreStatus = defineTaggedUnion({
  Idle: {},
  Opening: {},
  Ready: {},
  Failed: { message: Schema.String },
})

export type StoreStatus = typeof StoreStatus.Type

const Snapshot = {
  at: Schema.Number,
  pending: Schema.Int,
  maybeFailed: Schema.Option(Schema.Int),
  failedRefreshedAt: Schema.Number,
  mirror: MirrorSnapshot,
  pendingKeys: Schema.Array(Schema.String),
}

export const Model = Schema.Struct({
  maybeUserId: Schema.Option(Schema.String),
  hasHousehold: Schema.Boolean,
  status: StoreStatus,
  isOnline: Schema.Boolean,
  isVisible: Schema.Boolean,
  pending: Schema.Int,
  failed: Schema.Int,
  failedRefreshedAt: Schema.Number,
  isSyncing: Schema.Boolean,
  wakePending: Schema.Boolean,
  failures: Schema.Int,
  lastActivity: Schema.Number,
  isHalted: Schema.Boolean,
  hasSyncedOnce: Schema.Boolean,
  tick: Schema.Int,
  maybeError: Schema.Option(Schema.String),
  mirror: MirrorSnapshot,
  pendingKeys: Schema.Array(Schema.String),
})

export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  OpenedLocalStore: {},
  FailedOpenLocalStore: { message: Schema.String },
  ReleasedLocalStore: {},
  WentOnline: {},
  WentOffline: {},
  ChangedVisibility: { isVisible: Schema.Boolean },
  FocusedApp: {},
  TickedSyncSchedule: {},
  SucceededReadMirror: Snapshot,
  FailedReadMirror: { message: Schema.String },
  SucceededSyncPass: Snapshot,
  FailedSyncPass: {
    message: Schema.String,
    maybeCode: Schema.Option(Schema.String),
  },
  RequestedMirrorRefresh: {},
})

export type Message = typeof Message.Type

// COMMAND

class SyncOperationFailure extends Data.TaggedError('SyncOperationFailure')<{
  readonly message: string
  readonly maybeCode: Option.Option<string>
}> {}

const operationMessage = (cause: unknown): string => {
  if (cause instanceof SyncOperationFailure) return cause.message

  if (cause instanceof Error) return cause.message

  if (typeof cause === 'string') return cause

  if (
    typeof cause === 'object' &&
    cause !== null &&
    Reflect.get(cause, '_tag') === 'ResourceNotAvailable'
  ) {
    return 'حافظه‌ی محلی هنوز آماده نیست'
  }

  return 'عملیات محلی ناموفق بود'
}

const operationCode = (cause: unknown): Option.Option<string> =>
  cause instanceof SyncOperationFailure ? cause.maybeCode : Option.none()

const syncRejectedCode = (cause: unknown): Option.Option<string> =>
  cause instanceof SyncRejected ? Option.some(cause.code) : Option.none()

const tryStore = <A>(run: () => Promise<A>): Effect.Effect<A, string> =>
  Effect.tryPromise({
    try: run,
    catch: cause => storeErrorMessage(cause),
  })

const shouldRefreshFailed = (
  pendingBefore: number,
  pendingAfter: number,
  failedRefreshedAt: number,
  now: number,
): boolean =>
  failedRefreshedAt === 0 ||
  pendingAfter < pendingBefore ||
  now - failedRefreshedAt >= FAILED_REFRESH_INTERVAL_MS

export const ReadMirror = Command.define('ReadMirror', {
  args: { pendingBefore: Schema.Int, failedRefreshedAt: Schema.Number },
  messages: [Message.SucceededReadMirror, Message.FailedReadMirror],
  execute: ({ pendingBefore, failedRefreshedAt }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const pending = yield* tryStore(() => store.pendingCount())
      const now = yield* Clock.currentTimeMillis

      const maybeFailed = shouldRefreshFailed(
        pendingBefore,
        pending,
        failedRefreshedAt,
        now,
      )
        ? Option.some(yield* tryStore(() => store.failedCount()))
        : Option.none()

      const mirror = yield* tryStore(() => readMirrorSnapshot(store))
      const queued = yield* tryStore(() => store.pending())

      return Message.SucceededReadMirror({
        at: now,
        pending,
        maybeFailed,
        failedRefreshedAt: Option.isSome(maybeFailed) ? now : failedRefreshedAt,
        mirror,
        pendingKeys: pendingKeysOf(queued),
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReadMirror({ message: operationMessage(error) }),
        ),
      ),
    ),
})

const syncEngine = createSyncEngine(syncTransport())

export const RunSyncPass = Command.define('RunSyncPass', {
  args: { pendingBefore: Schema.Int, failedRefreshedAt: Schema.Number },
  messages: [Message.SucceededSyncPass, Message.FailedSyncPass],
  execute: ({ pendingBefore, failedRefreshedAt }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      yield* Effect.tryPromise({
        try: () => syncEngine.sync(store),
        catch: cause =>
          new SyncOperationFailure({
            message: operationMessage(cause),
            maybeCode: syncRejectedCode(cause),
          }),
      })
      const pending = yield* tryStore(() => store.pendingCount())
      const now = yield* Clock.currentTimeMillis

      const maybeFailed = shouldRefreshFailed(
        pendingBefore,
        pending,
        failedRefreshedAt,
        now,
      )
        ? Option.some(yield* tryStore(() => store.failedCount()))
        : Option.none()

      const mirror = yield* tryStore(() => readMirrorSnapshot(store))
      const queued = yield* tryStore(() => store.pending())

      return Message.SucceededSyncPass({
        at: now,
        pending,
        maybeFailed,
        failedRefreshedAt: Option.isSome(maybeFailed) ? now : failedRefreshedAt,
        mirror,
        pendingKeys: pendingKeysOf(queued),
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSyncPass({
            message: operationMessage(error),
            maybeCode: operationCode(error),
          }),
        ),
      ),
    ),
})

export const refreshMirror = (
  model: Model,
): Update.Return<Model, Message, LocalStoreService> => ({
  model,
  commands: [
    ReadMirror({
      pendingBefore: model.pending,
      failedRefreshedAt: model.failedRefreshedAt,
    }),
  ],
})

// INIT

export type InitOptions = Readonly<{
  maybeUserId: Option.Option<string>
  hasHousehold: boolean
  isOnline: boolean
  isVisible: boolean
}>

export const init = (options: InitOptions): Update.Return<Model, Message> => ({
  model: Model.make({
    maybeUserId: options.maybeUserId,
    hasHousehold: options.hasHousehold,
    status: Option.isSome(options.maybeUserId)
      ? StoreStatus.Opening()
      : StoreStatus.Idle(),
    isOnline: options.isOnline,
    isVisible: options.isVisible,
    pending: 0,
    failed: 0,
    failedRefreshedAt: 0,
    isSyncing: false,
    wakePending: false,
    failures: 0,
    lastActivity: 0,
    isHalted: false,
    hasSyncedOnce: false,
    tick: 0,
    maybeError: Option.none(),
    mirror: emptyMirrorSnapshot(),
    pendingKeys: [],
  }),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, LocalStoreService>

/** Keep the resource requirement and sync gate in step with the session. */
export const applySession = (
  model: Model,
  maybeUserId: Option.Option<string>,
  hasHousehold: boolean,
): Model =>
  modifyFields(model, {
    maybeUserId: () => maybeUserId,
    hasHousehold: () => hasHousehold,
    status: () => {
      if (Option.isNone(maybeUserId)) return model.status

      return StoreStatus.match(model.status, {
        Idle: () => StoreStatus.Opening(),
        Opening: () => model.status,
        Ready: () => model.status,
        Failed: () => model.status,
      })
    },
  })

const isReady = StoreStatus.isAnyOf(['Ready'])

/** Whether the local mirror is open and readable by the feature screens. */
export const isStoreReady = (model: Model): boolean => isReady(model.status)

const canRun = (model: Model): boolean =>
  isReady(model.status) &&
  model.hasHousehold &&
  model.isOnline &&
  !model.isHalted

const clearMirrorSnapshot = (model: Model): Model =>
  modifyFields(model, {
    status: () => StoreStatus.Idle(),
    pending: () => 0,
    failed: () => 0,
    failedRefreshedAt: () => 0,
    isSyncing: () => false,
    wakePending: () => false,
    failures: () => 0,
    lastActivity: () => 0,
    isHalted: () => false,
    hasSyncedOnce: () => false,
    tick: () => 0,
    maybeError: () => Option.none(),
    mirror: () => emptyMirrorSnapshot(),
    pendingKeys: () => [],
  })

/**
 * Start a pass now. A trigger that lands while one is running is remembered,
 * not dropped: the pass in flight may have read the outbox before that write
 * landed, and exactly one trailing pass mirrors the legacy `syncNow` rule.
 */
const beginSync = (model: Model): UpdateReturn => {
  if (!canRun(model)) return { model }

  if (model.isSyncing) {
    return { model: modifyFields(model, { wakePending: () => true }) }
  }

  return {
    model: modifyFields(model, {
      isSyncing: () => true,
      wakePending: () => false,
      maybeError: () => Option.none(),
    }),
    commands: [
      RunSyncPass({
        pendingBefore: model.pending,
        failedRefreshedAt: model.failedRefreshedAt,
      }),
    ],
  }
}

/**
 * A mirror read is the moment a local write becomes visible to the Model, so
 * it is also the moment to wake the engine. Failures keep their backoff: the
 * cadence Subscription schedules the retry instead of this path bypassing it.
 */
const syncAfterMirror = (model: Model): UpdateReturn =>
  model.failures === 0 && (model.pending > 0 || !model.hasSyncedOnce)
    ? beginSync(model)
    : { model }

const applySnapshot = (
  model: Model,
  snapshot: {
    readonly at: number
    readonly pending: number
    readonly maybeFailed: Option.Option<number>
    readonly failedRefreshedAt: number
    readonly mirror: MirrorSnapshot
    readonly pendingKeys: ReadonlyArray<string>
  },
): Model =>
  modifyFields(model, {
    pending: () => snapshot.pending,
    failed: () =>
      Option.match(snapshot.maybeFailed, {
        onNone: () => model.failed,
        onSome: failed => failed,
      }),
    failedRefreshedAt: () => snapshot.failedRefreshedAt,
    mirror: () => snapshot.mirror,
    pendingKeys: () => snapshot.pendingKeys,
    lastActivity: () => snapshot.at,
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    OpenedLocalStore: () => {
      const ready = modifyFields(model, {
        status: () => StoreStatus.Ready(),
        failures: () => 0,
        isHalted: () => false,
        hasSyncedOnce: () => false,
        maybeError: () => Option.none(),
      })

      return {
        model: ready,
        commands: [
          ReadMirror({
            pendingBefore: 0,
            failedRefreshedAt: 0,
          }),
        ],
      }
    },

    FailedOpenLocalStore: ({ message }) => ({
      model: modifyFields(model, {
        status: () => StoreStatus.Failed({ message }),
        maybeError: () => Option.some(message),
        isSyncing: () => false,
        wakePending: () => false,
      }),
    }),

    ReleasedLocalStore: () => ({
      model: clearMirrorSnapshot(model),
    }),

    WentOnline: () => beginSync(modifyFields(model, { isOnline: () => true })),

    WentOffline: () => ({
      model: modifyFields(model, { isOnline: () => false }),
    }),

    ChangedVisibility: ({ isVisible }) => {
      const next = modifyFields(model, { isVisible: () => isVisible })

      return isVisible ? beginSync(next) : { model: next }
    },

    FocusedApp: () => beginSync(model),

    TickedSyncSchedule: () => {
      const next = modifyFields(model, { tick: () => model.tick + 1 })

      return beginSync(next)
    },

    SucceededReadMirror: snapshot => {
      const next = applySnapshot(model, snapshot)

      return syncAfterMirror(next)
    },

    FailedReadMirror: ({ message }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(message) }),
    }),

    SucceededSyncPass: snapshot => {
      const shouldTrail = model.wakePending

      const next = modifyFields(applySnapshot(model, snapshot), {
        isSyncing: () => false,
        wakePending: () => false,
        failures: () => 0,
        hasSyncedOnce: () => true,
        maybeError: () => Option.none(),
      })

      return shouldTrail ? beginSync(next) : { model: next }
    },

    FailedSyncPass: ({ message, maybeCode }) => {
      const unauthorized = Option.contains(maybeCode, 'Unauthorized')

      return {
        model: modifyFields(model, {
          isSyncing: () => false,
          wakePending: () => false,
          failures: () => model.failures + 1,
          isHalted: () => model.isHalted || unauthorized,
          maybeError: () => Option.some(message),
        }),
      }
    },

    RequestedMirrorRefresh: () => refreshMirror(model),
  })

// MANAGED RESOURCE

/**
 * One IndexedDB mirror per signed-in user, opened as soon as the Model knows
 * the user id and closed on sign-out. The resource is what makes the store
 * available to Commands; the Model only keeps the snapshots and counts the
 * views read.
 */
export const managedResources = ManagedResource.make<Model, Message>()(
  entry => ({
    localStore: entry(Schema.Option(Schema.String), {
      resource: LocalStoreResource,
      modelToMaybeRequirements: model => model.maybeUserId,
      acquire: userId => openStore(userId),
      release: store => closeStore(store),
      onAcquired: () => Message.OpenedLocalStore(),
      onReleased: () => Message.ReleasedLocalStore(),
      onAcquireError: error =>
        Message.FailedOpenLocalStore({ message: storeErrorMessage(error) }),
    }),
  }),
)

// SUBSCRIPTION

const eventStream = <A>(
  subscribe: (emit: (value: A) => void) => () => void,
): Stream.Stream<A> =>
  Stream.callback<A>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribe(value => {
          Queue.offerUnsafe(queue, value)
        }),
      ),
      unsubscribe => Effect.sync(unsubscribe),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const onlineEvents: Stream.Stream<Message> = eventStream(emit => {
  const onOnline = () => emit(Message.WentOnline())
  const onOffline = () => emit(Message.WentOffline())

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
})

const visibilityEvents: Stream.Stream<Message> = eventStream(emit => {
  const onVisibilityChange = () =>
    emit(
      Message.ChangedVisibility({
        isVisible: document.visibilityState !== 'hidden',
      }),
    )

  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
})

const focusEvents: Stream.Stream<Message> = eventStream(emit => {
  const onFocus = () => emit(Message.FocusedApp())

  window.addEventListener('focus', onFocus)

  return () => {
    window.removeEventListener('focus', onFocus)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  online: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => onlineEvents,
    },
  ),

  visibility: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => visibilityEvents,
    },
  ),

  focus: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => focusEvents,
    },
  ),

  cadence: entry(
    {
      shouldPoll: Schema.Boolean,
      failures: Schema.Int,
      isVisible: Schema.Boolean,
      lastActivity: Schema.Number,
      tick: Schema.Int,
    },
    {
      modelToDependencies: model => ({
        shouldPoll: canRun(model),
        failures: model.failures,
        isVisible: model.isVisible,
        lastActivity: model.lastActivity,
        tick: model.tick,
      }),
      dependenciesToStream: dependencies =>
        Stream.when(
          Stream.fromEffect(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const sample = yield* Random.next

              const delay = syncDelayMs(
                {
                  failures: dependencies.failures,
                  visibility: dependencies.isVisible ? 'visible' : 'hidden',
                  lastActivity: dependencies.lastActivity,
                  now,
                },
                () => sample,
              )

              yield* Effect.sleep(Duration.millis(delay))

              return Message.TickedSyncSchedule()
            }),
          ),
          Effect.succeed(dependencies.shouldPoll),
        ),
    },
  ),
}))

// VIEW

const statusKind = (model: Model): SyncStatusKind =>
  StoreStatus.match<SyncStatusKind>(model.status, {
    Idle: () => 'idle',
    Opening: () => 'opening',
    Ready: () => 'ready',
    Failed: () => 'failed',
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  syncStatusView(
    {
      kind: statusKind(model),
      canSync: model.hasHousehold,
      isOnline: model.isOnline,
      isSyncing: model.isSyncing,
      isHalted: model.isHalted,
      pending: model.pending,
      failed: model.failed,
      maybeError: model.maybeError,
    },
    h,
  ),
)
