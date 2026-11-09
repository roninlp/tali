import {
  Array,
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Schema,
  Stream,
} from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { uuidV7 } from '@tali/domain'
import type { HabitEntryStatus } from '@tali/domain'
import { createTaskInMirror, todayInZone } from '@tali/sync-client'

import { habitStatusLabel } from '../habits-model'
import { AuthFailure } from '../lib/auth-api'
import { authErrorMessage } from '../lib/auth-copy'
import { habitEntryStatusOf, tapHabitEntry } from '../lib/habit-log'
import { preferencesApi } from '../lib/preferences-api'
import { TodayReadModel, fetchToday } from '../lib/today-api'
import { taskKey } from '../mirror'
import type { MirrorSnapshot } from '../mirror'
import { type DisplayFields, Preferences } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import {
  DashboardSection,
  DashboardSectionMove,
  HabitWindow,
  TodayFetchState,
  type TodayView,
  boundsFor,
  moveSection,
  orderedTasks,
  todayView,
  validTimeZone,
} from './today-model'
import { todayPageView } from './today-view'

/**
 * The Today screen Submodel.
 *
 * The Model owns the server read model and its ETag, the quick-add draft, the
 * inline-action busy/error state, the section-order panel, the keyboard cursor
 * and the habits-lane window. The mirror rows and connectivity live in the sync
 * Submodel and arrive as update/view inputs; every write goes through the
 * store first, then the root asks sync to re-read the mirror.
 */

// MODEL

export const Model = Schema.Struct({
  now: Schema.Number,
  fetchState: TodayFetchState,
  maybeServer: Schema.Option(TodayReadModel),
  maybeEtag: Schema.Option(Schema.String),
  refreshGeneration: Schema.Int,
  isFetching: Schema.Boolean,
  dirtyKeys: Schema.Array(Schema.String),
  draft: Schema.String,
  isAdding: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
  announcement: Schema.String,
  orderOpen: Schema.Boolean,
  orderBusy: Schema.Boolean,
  orderError: Schema.Option(Schema.String),
  cursor: Schema.Int,
  cursorActive: Schema.Boolean,
  habitWindow: HabitWindow,
  habitBusyId: Schema.Option(Schema.String),
  habitError: Schema.Option(Schema.String),
  habitAnnouncement: Schema.String,
})

export type Model = typeof Model.Type

export const initialModel = (now: number): Model =>
  Model.make({
    now,
    fetchState: TodayFetchState.Idle(),
    maybeServer: Option.none(),
    maybeEtag: Option.none(),
    refreshGeneration: 0,
    isFetching: false,
    dirtyKeys: [],
    draft: '',
    isAdding: false,
    maybeError: Option.none(),
    announcement: '',
    orderOpen: false,
    orderBusy: false,
    orderError: Option.none(),
    cursor: 0,
    cursorActive: false,
    habitWindow: 7,
    habitBusyId: Option.none(),
    habitError: Option.none(),
    habitAnnouncement: '',
  })

/** Everything the page reads from its siblings on each dispatch. */
export type Inputs = Readonly<{
  display: DisplayFields
  sectionOrder: ReadonlyArray<string>
  isStoreReady: boolean
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
}>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  EnteredToday: {},
  TickedClock: { now: Schema.Number },
  SyncSettled: {},
  WentOnline: {},
  WentOffline: {},
  SucceededFetchToday: {
    generation: Schema.Int,
    model: TodayReadModel,
    maybeEtag: Schema.Option(Schema.String),
    dirtyAtRequest: Schema.Array(Schema.String),
  },
  UnchangedFetchToday: {
    generation: Schema.Int,
    maybeEtag: Schema.Option(Schema.String),
  },
  FailedFetchToday: {
    generation: Schema.Int,
    failure: AuthFailure,
  },
  UpdatedQuickAddDraft: { value: Schema.String },
  SubmittedQuickAdd: {},
  ClickedFocusQuickAdd: {},
  CompletedFocusQuickAdd: {},
  CompletedCreateTask: { taskId: Schema.String, title: Schema.String },
  FailedCreateTask: { message: Schema.String },
  ClickedCompleteTask: { taskId: Schema.String, title: Schema.String },
  CompletedCompleteTask: { taskId: Schema.String, title: Schema.String },
  FailedCompleteTask: { message: Schema.String },
  ClickedMoveToTomorrow: { taskId: Schema.String, title: Schema.String },
  CompletedMoveToTomorrow: { taskId: Schema.String, title: Schema.String },
  FailedMoveToTomorrow: { message: Schema.String },
  ClickedToggleOrderPanel: {},
  ClickedMoveSection: {
    section: DashboardSection,
    direction: DashboardSectionMove,
  },
  SucceededSaveSectionOrder: {
    section: DashboardSection,
    preferences: Preferences,
  },
  FailedSaveSectionOrder: {
    section: DashboardSection,
    failure: AuthFailure,
  },
  PressedCursorDown: {},
  PressedCursorUp: {},
  PressedCursorComplete: {},
  PressedQuickAddShortcut: {},
  ClickedTimelineMark: { taskId: Schema.String },
  CompletedScrollToTask: {},
  SelectedHabitWindow: { window: HabitWindow },
  ClickedHabit: { habitId: Schema.String, title: Schema.String },
  CompletedTapHabit: {
    habitId: Schema.String,
    title: Schema.String,
    status: Schema.Literals(['done', 'partial', 'missed']),
  },
  FailedTapHabit: { message: Schema.String },
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
  SavedSectionOrder: { preferences: Preferences },
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

const storeFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره در حافظه‌ی محلی ناموفق بود'

const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

export const FetchToday = Command.define('FetchToday', {
  args: {
    generation: Schema.Int,
    maybeEtag: Schema.Option(Schema.String),
    dirtyAtRequest: Schema.Array(Schema.String),
  },
  messages: [
    Message.SucceededFetchToday,
    Message.UnchangedFetchToday,
    Message.FailedFetchToday,
  ],
  execute: ({ generation, maybeEtag, dirtyAtRequest }) =>
    fetchToday(maybeEtag).pipe(
      Effect.map(result => {
        if (!result.ok) {
          return Message.FailedFetchToday({
            generation,
            failure: result.error,
          })
        }

        if (result.notModified) {
          return Message.UnchangedFetchToday({
            generation,
            maybeEtag: result.maybeEtag,
          })
        }

        return Message.SucceededFetchToday({
          generation,
          model: result.model,
          maybeEtag: result.maybeEtag,
          dirtyAtRequest,
        })
      }),
    ),
})

export const FocusQuickAdd = Command.define('FocusQuickAdd', {
  messages: [Message.CompletedFocusQuickAdd],
  execute: Dom.focus('#today-quick-add', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusQuickAdd()),
  ),
})

export const ScrollToTask = Command.define('ScrollToTask', {
  args: { taskId: Schema.String },
  messages: [Message.CompletedScrollToTask],
  execute: ({ taskId }) =>
    Dom.scrollIntoView(`#today-task-${taskId}`, { block: 'nearest' }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollToTask()),
    ),
})

export const CreateTask = Command.define('CreateTask', {
  args: { title: Schema.String, timeZone: Schema.String },
  messages: [Message.CompletedCreateTask, Message.FailedCreateTask],
  execute: ({ title, timeZone }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const instant = new Date(now).toISOString()
      const zone = validTimeZone(timeZone)
      const taskId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createTaskInMirror(
            store,
            {
              title,
              dueDate: todayInZone(new Date(now), zone),
              priority: 'medium',
              projectId: null,
              tagIds: [],
              timeZone: zone,
            },
            taskId,
            instant,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const CompleteTask = Command.define('CompleteTask', {
  args: { taskId: Schema.String, title: Schema.String },
  messages: [Message.CompletedCompleteTask, Message.FailedCompleteTask],
  execute: ({ taskId, title }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          store.writeLocal({
            entityType: 'task',
            entityId: taskId,
            op: 'upsert',
            patch: { status: 'done', completedAt: now },
            now,
          }),
        catch: storeFailureMessage,
      })

      return Message.CompletedCompleteTask({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCompleteTask({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const MoveToTomorrow = Command.define('MoveToTomorrow', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    tomorrow: Schema.String,
    timeZone: Schema.String,
  },
  messages: [Message.CompletedMoveToTomorrow, Message.FailedMoveToTomorrow],
  execute: ({ taskId, title, tomorrow, timeZone }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          store.writeLocal({
            entityType: 'task',
            entityId: taskId,
            op: 'upsert',
            patch: { dueAt: null, dueDate: tomorrow, timeZone },
            now,
          }),
        catch: storeFailureMessage,
      })

      return Message.CompletedMoveToTomorrow({ taskId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedMoveToTomorrow({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const SaveSectionOrder = Command.define('SaveSectionOrder', {
  args: {
    section: DashboardSection,
    order: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededSaveSectionOrder, Message.FailedSaveSectionOrder],
  execute: ({ section, order }) =>
    preferencesApi.patch({ dashboardSectionOrder: order }).pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededSaveSectionOrder({
              section,
              preferences: result.value,
            })
          : Message.FailedSaveSectionOrder({
              section,
              failure: result.error,
            }),
      ),
    ),
})

export const TapHabit = Command.define('TapHabit', {
  args: {
    habitId: Schema.String,
    title: Schema.String,
    localDate: Schema.String,
    timeZone: Schema.String,
  },
  messages: [Message.CompletedTapHabit, Message.FailedTapHabit],
  execute: ({ habitId, title, localDate, timeZone }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis

      const record = yield* Effect.tryPromise({
        try: () =>
          tapHabitEntry(store, {
            habitId,
            localDate,
            timeZone: validTimeZone(timeZone),
            id: uuidV7(now),
            now: new Date(now).toISOString(),
          }),
        catch: storeFailureMessage,
      })

      const status: HabitEntryStatus = habitEntryStatusOf(record) ?? 'done'

      return Message.CompletedTapHabit({ habitId, title, status })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedTapHabit({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

// INIT

export type InitOptions = Readonly<{ now: number }>

export const init = (options: InitOptions): Update.Return<Model, Message> => ({
  model: initialModel(options.now),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>

type CommandReturn = Update.Return<Model, Message, LocalStoreService>

const currentView = (model: Model, inputs: Inputs): TodayView =>
  todayView({
    maybeServer: model.maybeServer,
    mirror: inputs.mirror,
    pendingKeys: inputs.pendingKeys,
    dirtyKeys: model.dirtyKeys,
    isOnline: inputs.isOnline,
    timeZone: inputs.display.timeZone,
    now: model.now,
  })

const startFetch = (model: Model): CommandReturn => {
  if (model.isFetching) {
    return { model }
  }

  const generation = model.refreshGeneration + 1

  const maybeEtag = Option.isSome(model.maybeServer)
    ? model.maybeEtag
    : Option.none()

  return {
    model: modifyFields(model, {
      isFetching: () => true,
      refreshGeneration: () => generation,
    }),
    commands: [
      FetchToday({
        generation,
        maybeEtag,
        dirtyAtRequest: model.dirtyKeys,
      }),
    ],
  }
}

const refreshIfSettled = (model: Model, inputs: Inputs): CommandReturn =>
  inputs.isOnline && inputs.pending === 0 ? startFetch(model) : { model }

const sectionTitle = (section: DashboardSection): string =>
  Match.value(section).pipe(
    Match.when('tasks', () => 'کارهای امروز'),
    Match.when('events', () => 'رویدادها'),
    Match.when('reminders', () => 'یادآورها'),
    Match.when('habits', () => 'عادت‌ها'),
    Match.orElse(() => 'یادداشت‌های پین‌شده'),
  )

const completeTask = (
  model: Model,
  inputs: Inputs,
  taskId: string,
  title: string,
): UpdateReturn => {
  const index = orderedTasks(
    currentView(model, inputs).tasks,
    inputs.display.timeZone,
  ).findIndex(task => task.id === taskId)

  return {
    model: modifyFields(model, {
      cursor: () => (index < 0 ? model.cursor : index),
      cursorActive: () => (index < 0 ? model.cursorActive : true),
      maybeError: () => Option.none(),
    }),
    commands: [CompleteTask({ taskId, title })],
  }
}

const stepCursor = (model: Model, inputs: Inputs, delta: -1 | 1): Model => {
  const tasks = orderedTasks(
    currentView(model, inputs).tasks,
    inputs.display.timeZone,
  )

  if (Array.isReadonlyArrayEmpty(tasks)) {
    return model
  }

  if (!model.cursorActive) {
    return modifyFields(model, { cursorActive: () => true })
  }

  const next = Math.max(0, Math.min(model.cursor + delta, tasks.length - 1))

  return modifyFields(model, { cursor: () => next, cursorActive: () => true })
}

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    EnteredToday: () => refreshIfSettled(model, inputs),

    TickedClock: ({ now }) => {
      const next = modifyFields(model, { now: () => now })

      return inputs.isOnline && inputs.pending === 0
        ? startFetch(next)
        : { model: next }
    },

    SyncSettled: () => refreshIfSettled(model, inputs),

    WentOnline: () => {
      const next = modifyFields(model, {
        fetchState: () => TodayFetchState.Idle(),
      })

      return inputs.pending === 0 ? startFetch(next) : { model: next }
    },

    WentOffline: () => ({
      model: modifyFields(model, {
        fetchState: () => TodayFetchState.Offline(),
        isFetching: () => false,
      }),
    }),

    SucceededFetchToday: ({
      generation,
      model: server,
      maybeEtag,
      dirtyAtRequest,
    }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServer: () => Option.some(server),
          maybeEtag: () => maybeEtag,
          fetchState: () => TodayFetchState.Ready(),
          isFetching: () => false,
          dirtyKeys: () =>
            Array.filter(
              model.dirtyKeys,
              key => !Array.contains(dirtyAtRequest, key),
            ),
        }),
      }
    },

    UnchangedFetchToday: ({ generation, maybeEtag }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeEtag: () => maybeEtag,
          fetchState: () => TodayFetchState.Ready(),
          isFetching: () => false,
        }),
      }
    },

    FailedFetchToday: ({ generation, failure }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServer: () => Option.none(),
          maybeEtag: () => Option.none(),
          fetchState: () =>
            failure.code === 'Network'
              ? TodayFetchState.Offline()
              : TodayFetchState.Error(),
          isFetching: () => false,
        }),
      }
    },

    UpdatedQuickAddDraft: ({ value }) => ({
      model: modifyFields(model, { draft: () => value }),
    }),

    SubmittedQuickAdd: () => {
      const title = model.draft.trim()

      if (!inputs.isStoreReady || title === '' || model.isAdding) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isAdding: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [CreateTask({ title, timeZone: inputs.display.timeZone })],
      }
    },

    ClickedFocusQuickAdd: () => ({
      model: modifyFields(model, { announcement: () => '' }),
      commands: [FocusQuickAdd()],
    }),
    CompletedFocusQuickAdd: () => ({ model }),

    CompletedCreateTask: ({ taskId, title }) => ({
      model: modifyFields(model, {
        isAdding: () => false,
        draft: () => '',
        maybeError: () => Option.none(),
        announcement: () => `کار تازه: ${title}`,
        dirtyKeys: () => [...model.dirtyKeys, taskKey(taskId)],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateTask: ({ message }) => ({
      model: modifyFields(model, {
        isAdding: () => false,
        maybeError: () => Option.some(message),
      }),
    }),

    ClickedCompleteTask: ({ taskId, title }) =>
      completeTask(model, inputs, taskId, title),

    CompletedCompleteTask: ({ taskId, title }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.none(),
        announcement: () => `انجام شد: ${title}`,
        dirtyKeys: () => [...model.dirtyKeys, taskKey(taskId)],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCompleteTask: ({ message }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(message) }),
    }),

    ClickedMoveToTomorrow: ({ taskId, title }) => {
      const bounds = boundsFor(inputs.display.timeZone, model.now)

      return {
        model: modifyFields(model, { maybeError: () => Option.none() }),
        commands: [
          MoveToTomorrow({
            taskId,
            title,
            tomorrow: bounds.tomorrow,
            timeZone: validTimeZone(inputs.display.timeZone),
          }),
        ],
      }
    },

    CompletedMoveToTomorrow: ({ taskId, title }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.none(),
        announcement: () => `به فردا منتقل شد: ${title}`,
        dirtyKeys: () => [...model.dirtyKeys, taskKey(taskId)],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedMoveToTomorrow: ({ message }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(message) }),
    }),

    ClickedToggleOrderPanel: () => ({
      model: modifyFields(model, { orderOpen: () => !model.orderOpen }),
    }),

    ClickedMoveSection: ({ section, direction }) => {
      if (model.orderBusy) {
        return { model }
      }

      const next = moveSection(inputs.sectionOrder, section, direction)

      const unchanged =
        next.length === inputs.sectionOrder.length &&
        next.every((value, index) => value === inputs.sectionOrder[index])

      if (unchanged) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          orderBusy: () => true,
          orderError: () => Option.none(),
        }),
        commands: [SaveSectionOrder({ section, order: next })],
      }
    },

    SucceededSaveSectionOrder: ({ section, preferences }) => ({
      model: modifyFields(model, {
        orderBusy: () => false,
        orderError: () => Option.none(),
        announcement: () => `ترتیب بخش‌ها به‌روز شد: ${sectionTitle(section)}`,
      }),
      outMessage: OutMessage.SavedSectionOrder({ preferences }),
    }),

    FailedSaveSectionOrder: ({ failure }) => ({
      model: modifyFields(model, {
        orderBusy: () => false,
        orderError: () => Option.some(authErrorMessage(failure.code)),
      }),
    }),

    PressedCursorDown: () => ({ model: stepCursor(model, inputs, 1) }),
    PressedCursorUp: () => ({ model: stepCursor(model, inputs, -1) }),
    PressedQuickAddShortcut: () => ({
      model: modifyFields(model, { announcement: () => '' }),
      commands: [FocusQuickAdd()],
    }),

    PressedCursorComplete: () => {
      if (!model.cursorActive) {
        return { model }
      }

      const task = orderedTasks(
        currentView(model, inputs).tasks,
        inputs.display.timeZone,
      )[model.cursor]

      return task === undefined
        ? { model }
        : completeTask(model, inputs, task.id, task.title)
    },

    ClickedTimelineMark: ({ taskId }) => {
      const index = orderedTasks(
        currentView(model, inputs).tasks,
        inputs.display.timeZone,
      ).findIndex(task => task.id === taskId)

      if (index < 0) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          cursor: () => index,
          cursorActive: () => true,
        }),
        commands: [ScrollToTask({ taskId })],
      }
    },

    CompletedScrollToTask: () => ({ model }),

    SelectedHabitWindow: ({ window }) => ({
      model: modifyFields(model, { habitWindow: () => window }),
    }),

    ClickedHabit: ({ habitId, title }) => {
      if (Option.isSome(model.habitBusyId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          habitBusyId: () => Option.some(habitId),
          habitError: () => Option.none(),
        }),
        commands: [
          TapHabit({
            habitId,
            title,
            localDate: currentView(model, inputs).today,
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    CompletedTapHabit: ({ title, status }) => ({
      model: modifyFields(model, {
        habitBusyId: () => Option.none(),
        habitError: () => Option.none(),
        habitAnnouncement: () => `${title}: ${habitStatusLabel(status)}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedTapHabit: ({ message }) => ({
      model: modifyFields(model, {
        habitBusyId: () => Option.none(),
        habitError: () => Option.some(message),
      }),
    }),
  })

/** Entry capability the root folds instead of constructing a child Message. */
export const entered = (model: Model, inputs: Inputs): CommandReturn =>
  refreshIfSettled(model, inputs)

/** A completed sync drain is the moment the read model can be revalidated. */
export const syncSettled = (model: Model, inputs: Inputs): CommandReturn =>
  refreshIfSettled(model, inputs)

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

const clockTick = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis

  return Message.TickedClock({ now })
})

/**
 * Tick once on mount (so a return to the screen refreshes "now" immediately)
 * and then once a minute; the subscription only runs while Today is the route.
 */
const clockEvents: Stream.Stream<Message> = Stream.concat(
  Stream.fromEffect(clockTick),
  Stream.fromEffectRepeat(
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.seconds(60))

      return yield* clockTick
    }),
  ),
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

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName))

const keyboardEvents: Stream.Stream<Message> = eventStream(emit => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
      return
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    if (event.key === '/') {
      event.preventDefault()
      emit(Message.PressedQuickAddShortcut())

      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      emit(Message.PressedCursorDown())

      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      emit(Message.PressedCursorUp())

      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      emit(Message.PressedCursorComplete())
    }
  }

  document.addEventListener('keydown', onKeyDown)

  return () => {
    document.removeEventListener('keydown', onKeyDown)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  todayClock: Subscription.persistentEntry(clockEvents),
  todayOnline: Subscription.persistentEntry(onlineEvents),
  todayKeyboard: Subscription.persistentEntry(keyboardEvents),
}))

// VIEW

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => todayPageView(model, inputs, h),
)
