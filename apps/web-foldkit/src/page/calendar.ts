import { Array, Clock, Effect, Match, Option, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Listbox } from '@foldkit/ui'
import {
  type CalendarTaskItem,
  type Event,
  EventExceptionId,
  EventId,
  LocalDate,
  type Priority,
  uuidV7,
} from '@tali/domain'
import { createTaskInMirror } from '@tali/sync-client'

import { AuthFailure as AuthFailureSchema } from '../lib/auth-api'
import { fetchCalendarMonth, fetchCalendarWeek } from '../lib/calendar-api'
import {
  CalendarEventOccurrence,
  CalendarMonthPayload,
  CalendarWeekPayload,
} from '../lib/calendar-data'
import {
  CalendarEventDraft as CalendarEventDraftSchema,
  EVENT_MISSING_COPY,
  EventScopeIds as EventScopeIdsSchema,
  applyEventChangeFromServer,
  applyEventScopeInMirror,
  createEventInMirror,
  deleteEventWithinScope,
  draftFromOccurrence,
  editEventWithinScope,
  eventFromMirror,
  eventScopeIdsOrMint,
  eventScopeUsesServer,
  newScopedIds,
  timingOfDraft,
  toEventRow,
} from '../lib/event-writes'
import {
  type OccasionRow,
  OccasionRow as OccasionRowSchema,
  createOccasionInMirror,
  deleteOccasionInMirror,
  prepareOccasionTaskInMirror,
  updateOccasionInMirror,
} from '../lib/occasion-writes'
import { withRpcClient } from '../lib/rpc'
import { TimestampMillis } from '../lib/schema-primitives'
import {
  completeTaskInMirror,
  moveTaskInMirror,
  updateTaskInMirror,
} from '../lib/task-writes'
import { setVisibilityInMirror } from '../lib/visibility-writes'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import { clockEvents, eventStream, onlineEvents } from '../ui/dom-stream'
import {
  listboxOutMessageFold,
  optionalListboxOutMessageFold,
} from '../ui/fold'
import * as Picker from '../ui/picker'
import {
  CalendarFetchState,
  type CalendarReadInputs,
  type CalendarView,
  PRIORITY_LABELS,
  calendarViewOf,
  dayLabel,
  shiftDay,
  shiftMonth,
  todayIn,
} from './calendar-model'
import { calendarPageView } from './calendar-view'
import { localWrite, storeFailureMessage } from './local-write'

/**
 * The `/calendar` screen Submodel, ported from
 * `apps/web/src/components/calendar/calendar-screen.tsx` and the occasions
 * panel from `apps/web/src/components/occasions/occasions-panel.tsx`.
 *
 * The Model owns the view/anchor/selected day, the server week and month
 * snapshots with their ETags, the quick-add drafts, the event editor and
 * scope prompt, the occasion form and the announcements. Mirror rows and
 * connectivity arrive as update/view inputs; every write goes through the
 * store first, then the root asks sync to re-read the mirror. Recurring
 * occurrence edits are the one exception: online with a clean head they use
 * the service's gated split RPC, exactly like the legacy screen.
 */

const asNonEmptyString = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isMinLength(1)),
)

// MODEL

export const CalendarEditScope = Schema.Literals([
  'thisOccurrence',
  'thisAndFollowing',
])

export type CalendarEditScope = typeof CalendarEditScope.Type

export const CalendarScopeAction = Schema.Literals(['edit', 'delete'])

export type CalendarScopeAction = typeof CalendarScopeAction.Type

export const CalendarTaskDraft = Schema.Struct({
  date: Schema.String,
  value: Schema.String,
})

export type CalendarTaskDraft = typeof CalendarTaskDraft.Type

export const CalendarQuickEventDraft = Schema.Struct({
  date: Schema.String,
  title: Schema.String,
  allDay: Schema.Boolean,
  startTime: Schema.String,
  endTime: Schema.String,
  open: Schema.Boolean,
})

export type CalendarQuickEventDraft = typeof CalendarQuickEventDraft.Type

export const CalendarEventEditorState = Schema.Struct({
  occurrence: CalendarEventOccurrence,
  draft: CalendarEventDraftSchema,
})

export type CalendarEventEditorState = typeof CalendarEventEditorState.Type

export const CalendarPendingScope = Schema.Struct({
  action: CalendarScopeAction,
  occurrence: CalendarEventOccurrence,
  maybeDraft: Schema.Option(CalendarEventDraftSchema),
  maybeIds: Schema.Option(EventScopeIdsSchema),
})

export type CalendarPendingScope = typeof CalendarPendingScope.Type

export type AdvanceOption = Readonly<{
  value: string
  label: string
}>

export const OccasionAdvanceListbox = Listbox.create<AdvanceOption, string>()

export type PlanningPriorityOption = Readonly<{
  value: Priority
  label: string
}>

export const PlanningPriorityListboxEntry = Schema.Struct({
  taskId: Schema.String,
  listbox: Listbox.Model,
})

export type PlanningPriorityListboxEntry =
  typeof PlanningPriorityListboxEntry.Type

export const PlanningPriorityListbox = Listbox.create<
  PlanningPriorityOption,
  string
>()

export const Model = Schema.Struct({
  now: TimestampMillis,
  view: Schema.Literals(['week', 'month']),
  anchor: Schema.String,
  maybeSelectedDay: Schema.Option(Schema.String),
  planningOpen: Schema.Boolean,
  fetchState: CalendarFetchState,
  maybeServerWeek: Schema.Option(CalendarWeekPayload),
  maybeServerWeekEtag: Schema.Option(Schema.String),
  maybeServerMonth: Schema.Option(CalendarMonthPayload),
  maybeServerMonthEtag: Schema.Option(Schema.String),
  refreshGeneration: Schema.Int,
  dirtyTaskIds: Schema.Array(Schema.String),
  dirtyEventIds: Schema.Array(Schema.String),
  taskDrafts: Schema.Array(CalendarTaskDraft),
  quickEvents: Schema.Array(CalendarQuickEventDraft),
  maybeBusyKey: Schema.Option(Schema.String),
  maybePageError: Schema.Option(Schema.String),
  announcement: Schema.String,
  maybeEditingEvent: Schema.Option(CalendarEventEditorState),
  maybePendingScope: Schema.Option(CalendarPendingScope),
  eventScope: CalendarEditScope,
  isEventBusy: Schema.Boolean,
  maybeEditorError: Schema.Option(Schema.String),
  occasionEditingId: Schema.Option(Schema.String),
  occasionTitle: Schema.String,
  occasionOriginDate: Schema.String,
  occasionYearly: Schema.Boolean,
  occasionAdvance: Schema.String,
  occasionAdvanceListbox: Listbox.Model,
  planningPriorityListboxes: Schema.Array(PlanningPriorityListboxEntry),
  maybeOccasionBusy: Schema.Option(Schema.String),
  maybeOccasionError: Schema.Option(Schema.String),
  occasionAnnouncement: Schema.String,
  picker: Picker.Model,
})

export type Model = typeof Model.Type

/** Everything the screen reads from its siblings on each dispatch. */
export type Inputs = CalendarReadInputs &
  Readonly<{
    isStoreReady: boolean
    maybeUserId: Option.Option<string>
    maybeHouseholdId: Option.Option<string>
  }>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  TickedCalendar: { now: TimestampMillis },
  WentOnline: {},
  WentOffline: {},
  SucceededFetchWeek: {
    generation: Schema.Int,
    model: CalendarWeekPayload,
    maybeEtag: Schema.Option(Schema.String),
    dirtyAtRequest: Schema.Array(Schema.String),
    dirtyEventsAtRequest: Schema.Array(Schema.String),
  },
  UnchangedFetchWeek: {
    generation: Schema.Int,
    maybeEtag: Schema.Option(Schema.String),
  },
  FailedFetchWeek: { generation: Schema.Int, failure: AuthFailureSchema },
  SucceededFetchMonth: {
    generation: Schema.Int,
    model: CalendarMonthPayload,
    maybeEtag: Schema.Option(Schema.String),
    dirtyAtRequest: Schema.Array(Schema.String),
    dirtyEventsAtRequest: Schema.Array(Schema.String),
  },
  UnchangedFetchMonth: {
    generation: Schema.Int,
    maybeEtag: Schema.Option(Schema.String),
  },
  FailedFetchMonth: { generation: Schema.Int, failure: AuthFailureSchema },
  SelectedCalendarView: { view: Schema.Literals(['week', 'month']) },
  PressedPreviousWeek: {},
  PressedNextWeek: {},
  PressedTodayWeek: {},
  PressedPreviousMonth: {},
  PressedNextMonth: {},
  PressedTodayMonth: {},
  SelectedCalendarDay: { date: Schema.String },
  ClosedCalendarDay: {},
  OpenedDayInWeek: { date: Schema.String },
  ClickedTogglePlanning: {},
  UpdatedTaskDraft: { date: Schema.String, value: Schema.String },
  SubmittedTaskQuickAdd: { date: Schema.String },
  CompletedCreateCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    date: Schema.String,
  },
  FailedCreateCalendarTask: { message: Schema.String },
  ClickedCompleteCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    projected: Schema.Boolean,
  },
  CompletedCompleteCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
  },
  FailedCompleteCalendarTask: { message: Schema.String },
  ClickedPrioritizeCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    priority: Schema.Literals(['high', 'medium', 'low']),
    currentPriority: Schema.Literals(['high', 'medium', 'low']),
    projected: Schema.Boolean,
  },
  CompletedPrioritizeCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    priority: Schema.Literals(['high', 'medium', 'low']),
  },
  FailedPrioritizeCalendarTask: { message: Schema.String },
  ClickedMoveCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    date: Schema.String,
    days: Schema.Int,
    projected: Schema.Boolean,
  },
  CompletedMoveCalendarTask: {
    taskId: Schema.String,
    title: Schema.String,
    target: Schema.String,
  },
  FailedMoveCalendarTask: { message: Schema.String },
  ToggledEventQuickAdd: { date: Schema.String, isOpen: Schema.Boolean },
  UpdatedQuickEventTitle: { date: Schema.String, value: Schema.String },
  ToggledQuickEventAllDay: { date: Schema.String, allDay: Schema.Boolean },
  UpdatedQuickEventStart: { date: Schema.String, value: Schema.String },
  UpdatedQuickEventEnd: { date: Schema.String, value: Schema.String },
  SubmittedEventQuickAdd: { date: Schema.String },
  CompletedCreateCalendarEvent: {
    eventId: Schema.String,
    title: Schema.String,
    date: Schema.String,
  },
  FailedCreateCalendarEvent: { message: Schema.String },
  OpenedEventEditor: { occurrence: CalendarEventOccurrence },
  ClosedEventEditor: {},
  CompletedFocusEventEditor: {},
  UpdatedEventEditorTitle: { value: Schema.String },
  ToggledEventEditorAllDay: { allDay: Schema.Boolean },
  UpdatedEventEditorDate: { value: Schema.String },
  UpdatedEventEditorStart: { value: Schema.String },
  UpdatedEventEditorEnd: { value: Schema.String },
  SubmittedEventEditor: {},
  ClickedToggleEventVisibility: {},
  CompletedSetEventVisibility: {
    eventId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetEventVisibility: { message: Schema.String },
  ClickedDeleteEvent: {},
  CompletedGenerateEventScopeIds: { ids: EventScopeIdsSchema },
  SelectedEventScope: { scope: CalendarEditScope },
  PressedConfirmEventScope: {},
  PressedCancelEventScope: {},
  CompletedFocusScopePrompt: {},
  CompletedCommitEventScope: {
    action: CalendarScopeAction,
    scope: CalendarEditScope,
    seriesId: Schema.String,
    maybeFollowingId: Schema.Option(Schema.String),
    title: Schema.String,
  },
  FailedCommitEventScope: { message: Schema.String },
  PressedEscape: {},
  UpdatedOccasionTitle: { value: Schema.String },
  UpdatedOccasionOriginDate: { value: Schema.String },
  ToggledOccasionYearly: { yearly: Schema.Boolean },
  SelectedOccasionAdvance: { value: Schema.String },
  GotOccasionAdvanceListboxMessage: { message: Listbox.Message },
  GotPickerMessage: { message: Picker.Message },
  GotPlanningPriorityListboxMessage: {
    taskId: Schema.String,
    message: Listbox.Message,
  },
  SubmittedOccasion: {},
  ClickedEditOccasion: { occasionId: Schema.String },
  ClickedToggleOccasionVisibility: {},
  CompletedSetOccasionVisibility: {
    occasionId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetOccasionVisibility: { message: Schema.String },
  ClickedCancelOccasionEdit: {},
  CompletedSaveOccasion: {
    occasionId: Schema.String,
    title: Schema.String,
    isEdit: Schema.Boolean,
  },
  FailedSaveOccasion: { message: Schema.String },
  ClickedDeleteOccasion: { occasionId: Schema.String, title: Schema.String },
  CompletedDeleteOccasion: { occasionId: Schema.String, title: Schema.String },
  FailedDeleteOccasion: { message: Schema.String },
  ClickedPrepareOccasion: { occasionId: Schema.String, title: Schema.String },
  CompletedPrepareOccasion: {
    title: Schema.String,
    created: Schema.Boolean,
  },
  FailedPrepareOccasion: {
    noUpcomingOccurrence: Schema.Boolean,
    message: Schema.String,
  },
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

const eventFailureMessage = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : 'ذخیرهٔ رویداد در حافظهٔ محلی ناموفق بود'

export const ReadCalendarClock = Command.define('ReadCalendarClock', {
  messages: [Message.TickedCalendar],
  execute: Clock.currentTimeMillis.pipe(
    Effect.map(now => Message.TickedCalendar({ now })),
  ),
})

export const FocusEventEditor = Command.define('FocusEventEditor', {
  messages: [Message.CompletedFocusEventEditor],
  execute: Dom.focus('#calendar-event-editor-title', {
    preventScroll: true,
  }).pipe(Effect.ignore, Effect.as(Message.CompletedFocusEventEditor())),
})

export const FocusScopePrompt = Command.define('FocusScopePrompt', {
  messages: [Message.CompletedFocusScopePrompt],
  execute: Dom.focus('#calendar-scope-this', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusScopePrompt()),
  ),
})

export const FetchCalendar = Command.define('FetchCalendar', {
  args: {
    view: Schema.Literals(['week', 'month']),
    anchor: Schema.String,
    maybeDay: Schema.Option(Schema.String),
    maybeEtag: Schema.Option(Schema.String),
    generation: Schema.Int,
    dirtyAtRequest: Schema.Array(Schema.String),
    dirtyEventsAtRequest: Schema.Array(Schema.String),
  },
  messages: [
    Message.SucceededFetchWeek,
    Message.UnchangedFetchWeek,
    Message.FailedFetchWeek,
    Message.SucceededFetchMonth,
    Message.UnchangedFetchMonth,
    Message.FailedFetchMonth,
  ],
  execute: ({
    view,
    anchor,
    maybeDay,
    maybeEtag,
    generation,
    dirtyAtRequest,
    dirtyEventsAtRequest,
  }) =>
    Effect.gen(function* () {
      if (view === 'week') {
        const result = yield* fetchCalendarWeek(anchor, maybeEtag)

        if (!result.ok) {
          return Message.FailedFetchWeek({
            generation,
            failure: result.error,
          })
        }

        return result.notModified
          ? Message.UnchangedFetchWeek({
              generation,
              maybeEtag: result.maybeEtag,
            })
          : Message.SucceededFetchWeek({
              generation,
              model: result.model,
              maybeEtag: result.maybeEtag,
              dirtyAtRequest,
              dirtyEventsAtRequest,
            })
      }

      const result = yield* fetchCalendarMonth(anchor, maybeDay, maybeEtag)

      if (!result.ok) {
        return Message.FailedFetchMonth({
          generation,
          failure: result.error,
        })
      }

      return result.notModified
        ? Message.UnchangedFetchMonth({
            generation,
            maybeEtag: result.maybeEtag,
          })
        : Message.SucceededFetchMonth({
            generation,
            model: result.model,
            maybeEtag: result.maybeEtag,
            dirtyAtRequest,
            dirtyEventsAtRequest,
          })
    }),
})

export const CreateCalendarTask = Command.define('CreateCalendarTask', {
  args: {
    title: Schema.String,
    date: Schema.String,
    timeZone: Schema.String,
  },
  messages: [
    Message.CompletedCreateCalendarTask,
    Message.FailedCreateCalendarTask,
  ],
  execute: ({ title, date, timeZone }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const taskId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createTaskInMirror(
            store,
            {
              title,
              dueDate: date,
              priority: 'medium',
              projectId: null,
              tagIds: [],
              timeZone,
            },
            taskId,
            new Date(now).toISOString(),
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateCalendarTask({ taskId, title, date })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateCalendarTask({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const CompleteCalendarTask = Command.define('CompleteCalendarTask', {
  args: { taskId: Schema.String, title: Schema.String },
  messages: [
    Message.CompletedCompleteCalendarTask,
    Message.FailedCompleteCalendarTask,
  ],
  execute: ({ taskId, title }) =>
    localWrite({
      run: (store, now) => completeTaskInMirror(store, taskId, now),
      onSuccess: () => Message.CompletedCompleteCalendarTask({ taskId, title }),
      onFailure: message => Message.FailedCompleteCalendarTask({ message }),
    }),
})

export const PrioritizeCalendarTask = Command.define('PrioritizeCalendarTask', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    priority: Schema.Literals(['high', 'medium', 'low']),
  },
  messages: [
    Message.CompletedPrioritizeCalendarTask,
    Message.FailedPrioritizeCalendarTask,
  ],
  execute: ({ taskId, title, priority }) =>
    localWrite({
      run: (store, now) => updateTaskInMirror(store, taskId, { priority }, now),
      onSuccess: () =>
        Message.CompletedPrioritizeCalendarTask({ taskId, title, priority }),
      onFailure: message => Message.FailedPrioritizeCalendarTask({ message }),
    }),
})

export const MoveCalendarTask = Command.define('MoveCalendarTask', {
  args: {
    taskId: Schema.String,
    title: Schema.String,
    target: Schema.String,
    timeZone: Schema.String,
  },
  messages: [Message.CompletedMoveCalendarTask, Message.FailedMoveCalendarTask],
  execute: ({ taskId, title, target, timeZone }) =>
    localWrite({
      run: (store, now) =>
        moveTaskInMirror(store, taskId, target, timeZone, now),
      onSuccess: () =>
        Message.CompletedMoveCalendarTask({ taskId, title, target }),
      onFailure: message => Message.FailedMoveCalendarTask({ message }),
    }),
})

export const CreateCalendarEvent = Command.define('CreateCalendarEvent', {
  args: {
    draft: CalendarEventDraftSchema,
    timeZone: Schema.String,
  },
  messages: [
    Message.CompletedCreateCalendarEvent,
    Message.FailedCreateCalendarEvent,
  ],
  execute: ({ draft, timeZone }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const eventId = uuidV7(now)

      yield* Effect.tryPromise({
        try: () =>
          createEventInMirror(
            store,
            { ...draft, timeZone },
            eventId,
            new Date(now).toISOString(),
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateCalendarEvent({
        eventId,
        title: draft.title,
        date: draft.date,
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateCalendarEvent({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetCalendarEventVisibility = Command.define(
  'SetCalendarEventVisibility',
  {
    args: {
      eventId: Schema.String,
      visibility: Schema.Literals(['private', 'shared']),
    },
    messages: [
      Message.CompletedSetEventVisibility,
      Message.FailedSetEventVisibility,
    ],
    execute: ({ eventId, visibility }) =>
      localWrite({
        run: (store, now) =>
          setVisibilityInMirror(store, 'event', eventId, visibility, now),
        onSuccess: () =>
          Message.CompletedSetEventVisibility({ eventId, visibility }),
        onFailure: message => Message.FailedSetEventVisibility({ message }),
      }),
  },
)

export const SetCalendarOccasionVisibility = Command.define(
  'SetCalendarOccasionVisibility',
  {
    args: {
      occasionId: Schema.String,
      visibility: Schema.Literals(['private', 'shared']),
    },
    messages: [
      Message.CompletedSetOccasionVisibility,
      Message.FailedSetOccasionVisibility,
    ],
    execute: ({ occasionId, visibility }) =>
      localWrite({
        run: (store, now) =>
          setVisibilityInMirror(store, 'occasion', occasionId, visibility, now),
        onSuccess: () =>
          Message.CompletedSetOccasionVisibility({ occasionId, visibility }),
        onFailure: message => Message.FailedSetOccasionVisibility({ message }),
      }),
  },
)

export const GenerateEventScopeIds = Command.define('GenerateEventScopeIds', {
  messages: [Message.CompletedGenerateEventScopeIds],
  execute: Clock.currentTimeMillis.pipe(
    Effect.map(now =>
      Message.CompletedGenerateEventScopeIds({ ids: newScopedIds(now) }),
    ),
  ),
})

export const CommitCalendarEventScope = Command.define(
  'CommitCalendarEventScope',
  {
    args: {
      occurrence: CalendarEventOccurrence,
      action: CalendarScopeAction,
      scope: CalendarEditScope,
      maybeDraft: Schema.Option(CalendarEventDraftSchema),
      maybeIds: Schema.Option(EventScopeIdsSchema),
      isOnline: Schema.Boolean,
      maybeUserId: Schema.Option(Schema.String),
      maybeHouseholdId: Schema.Option(Schema.String),
    },
    messages: [
      Message.CompletedCommitEventScope,
      Message.FailedCommitEventScope,
    ],
    execute: ({
      occurrence,
      action,
      scope,
      maybeDraft,
      maybeIds,
      isOnline,
      maybeUserId,
      maybeHouseholdId,
    }) =>
      Effect.gen(function* () {
        const store = yield* LocalStoreResource.get
        const now = yield* Clock.currentTimeMillis
        const instant = new Date(now).toISOString()

        const record = yield* Effect.tryPromise({
          try: () => store.get('event', occurrence.id),
          catch: storeFailureMessage,
        })

        const maybeFallback = Option.flatMap(maybeUserId, userId =>
          Option.map(maybeHouseholdId, householdId => ({
            userId,
            householdId,
          })),
        )

        const maybeEvent = Option.flatMap(maybeFallback, fallback =>
          Option.fromNullishOr(
            record === undefined
              ? null
              : eventFromMirror(toEventRow(record), fallback),
          ),
        )

        if (Option.isNone(maybeEvent)) {
          return yield* Effect.fail(EVENT_MISSING_COPY)
        }

        const event = maybeEvent.value
        const ids = eventScopeIdsOrMint(maybeIds, now)

        const overrides = Option.match(maybeDraft, {
          onNone: () => ({}),
          onSome: draft => ({
            title: draft.title,
            timing: timingOfDraft({
              ...draft,
              timeZone: occurrence.timeZone,
            }),
          }),
        })

        const hasPending = yield* Effect.tryPromise({
          try: () => store.hasPending('event', event.id),
          catch: storeFailureMessage,
        })

        const useServer = yield* Effect.try({
          try: () =>
            eventScopeUsesServer({
              event,
              action,
              scope,
              isOnline,
              hasPending,
            }),
          catch: eventFailureMessage,
        })

        if (!useServer) {
          const change = yield* Effect.try({
            try: () =>
              action === 'edit'
                ? editEventWithinScope({
                    event,
                    instanceId: occurrence.instanceId,
                    overrides,
                    scope,
                    exceptionId: ids.exceptionId,
                    followingId: ids.followingId,
                    now: instant,
                  })
                : deleteEventWithinScope({
                    event,
                    instanceId: occurrence.instanceId,
                    scope,
                    exceptionId: ids.exceptionId,
                    followingId: ids.followingId,
                    now: instant,
                  }),
            catch: eventFailureMessage,
          })

          yield* Effect.tryPromise({
            try: () => applyEventScopeInMirror(store, change, instant),
            catch: storeFailureMessage,
          })

          return Message.CompletedCommitEventScope({
            action,
            scope,
            seriesId: change.series.id,
            maybeFollowingId: Option.map(
              Option.fromNullishOr(change.following),
              following => following.id,
            ),
            title: Option.match(maybeDraft, {
              onNone: () => occurrence.title,
              onSome: draft => draft.title,
            }),
          })
        }

        const base = {
          id: EventId.make(event.id),
          instanceId: LocalDate.make(occurrence.instanceId),
          clientMutationId: ids.clientMutationId,
          scope,
          exceptionId: EventExceptionId.make(ids.exceptionId),
        }

        const change = yield* withRpcClient(client => {
          if (action !== 'edit') {
            return client.DeleteEventOccurrence(base)
          }

          const scoped =
            scope === 'thisAndFollowing'
              ? {
                  ...base,
                  followingId: EventId.make(ids.followingId),
                  followingMutationId: ids.followingMutationId,
                }
              : base

          return client.EditEventOccurrence({ ...scoped, overrides })
        })

        // In a production build the RPC client decodes the complete domain
        // `Event` rows, so the mirror can adopt them immediately. In the Vite
        // dev server `effect/schema` is a second module graph (see
        // `vite.config.ts`), so the decoded rows can lose their Model variant
        // fields. The server write is authoritative either way: keep the ids
        // dirty and let the next sync pull bring both rows into the mirror.
        const hasCompleteSeries = Option.isSome(
          asNonEmptyString(change.series.id),
        )

        const hasCompleteFollowing =
          change.following === null ||
          Option.isSome(asNonEmptyString(change.following.id))

        if (hasCompleteSeries && hasCompleteFollowing) {
          yield* Effect.tryPromise({
            try: () => applyEventChangeFromServer(store, change),
            catch: storeFailureMessage,
          })
        }

        const seriesId = hasCompleteSeries ? change.series.id : event.id

        const maybeFollowingId = Option.match(
          Option.fromNullishOr(change.following),
          {
            onNone: () =>
              action === 'edit' && scope === 'thisAndFollowing'
                ? Option.some(ids.followingId)
                : Option.none<string>(),
            onSome: following =>
              Option.isSome(asNonEmptyString(following.id))
                ? Option.some(following.id)
                : Option.some(ids.followingId),
          },
        )

        return Message.CompletedCommitEventScope({
          action,
          scope,
          seriesId,
          maybeFollowingId,
          title: Option.match(maybeDraft, {
            onNone: () => occurrence.title,
            onSome: draft => draft.title,
          }),
        })
      }).pipe(
        Effect.catch(error =>
          Effect.succeed(
            Message.FailedCommitEventScope({
              message: eventFailureMessage(error),
            }),
          ),
        ),
      ),
  },
)

export const SaveCalendarOccasion = Command.define('SaveCalendarOccasion', {
  args: {
    maybeEditingId: Schema.Option(Schema.String),
    title: Schema.String,
    originDate: Schema.String,
    yearly: Schema.Boolean,
    maybeAdvanceDays: Schema.Option(Schema.Int),
    timeZone: Schema.String,
  },
  messages: [Message.CompletedSaveOccasion, Message.FailedSaveOccasion],
  execute: ({
    maybeEditingId,
    title,
    originDate,
    yearly,
    maybeAdvanceDays,
    timeZone,
  }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const instant = new Date(now).toISOString()
      const advanceDays = Option.getOrNull(maybeAdvanceDays)

      const occasionId = yield* Effect.tryPromise({
        try: () =>
          Option.match(maybeEditingId, {
            onNone: async () =>
              createOccasionInMirror(
                store,
                {
                  title,
                  originDate,
                  timeZone,
                  yearly,
                  advanceReminderDays: advanceDays,
                },
                uuidV7(now),
                instant,
              ),
            onSome: async occasionId => {
              await updateOccasionInMirror(
                store,
                occasionId,
                { title, originDate, yearly, advanceReminderDays: advanceDays },
                instant,
              )

              return occasionId
            },
          }),
        catch: storeFailureMessage,
      })

      return Message.CompletedSaveOccasion({
        occasionId,
        title,
        isEdit: Option.isSome(maybeEditingId),
      })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveOccasion({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const DeleteCalendarOccasion = Command.define('DeleteCalendarOccasion', {
  args: { occasionId: Schema.String, title: Schema.String },
  messages: [Message.CompletedDeleteOccasion, Message.FailedDeleteOccasion],
  execute: ({ occasionId, title }) =>
    localWrite({
      run: (store, now) => deleteOccasionInMirror(store, occasionId, now),
      onSuccess: () => Message.CompletedDeleteOccasion({ occasionId, title }),
      onFailure: message => Message.FailedDeleteOccasion({ message }),
      fallbackMessage: 'حذف مناسبت ناموفق بود',
    }),
})

export const PrepareCalendarOccasionTask = Command.define(
  'PrepareCalendarOccasionTask',
  {
    args: {
      occasion: OccasionRowSchema,
      today: Schema.String,
    },
    messages: [Message.CompletedPrepareOccasion, Message.FailedPrepareOccasion],
    execute: ({ occasion, today }) =>
      Effect.gen(function* () {
        const store = yield* LocalStoreResource.get
        const now = yield* Clock.currentTimeMillis

        const result = yield* Effect.tryPromise({
          try: () =>
            prepareOccasionTaskInMirror(
              store,
              occasion,
              today,
              uuidV7(now),
              new Date(now).toISOString(),
            ),
          catch: storeFailureMessage,
        })

        return Message.CompletedPrepareOccasion({
          title: occasion.title,
          created: result.created,
        })
      }).pipe(
        Effect.catch(error => {
          const message = storeFailureMessage(error)

          return Effect.succeed(
            Message.FailedPrepareOccasion({
              noUpcomingOccurrence:
                message === 'this occasion has no upcoming occurrence',
              message,
            }),
          )
        }),
      ),
  },
)

// INIT

export type InitOptions = Readonly<{ now: number }>

export const initialModel = (now: number): Model =>
  Model.make({
    now,
    view: 'week',
    anchor: todayIn('Asia/Tehran', new Date(now)),
    maybeSelectedDay: Option.none(),
    planningOpen: false,
    fetchState: CalendarFetchState.Idle(),
    maybeServerWeek: Option.none(),
    maybeServerWeekEtag: Option.none(),
    maybeServerMonth: Option.none(),
    maybeServerMonthEtag: Option.none(),
    refreshGeneration: 0,
    dirtyTaskIds: [],
    dirtyEventIds: [],
    taskDrafts: [],
    quickEvents: [],
    maybeBusyKey: Option.none(),
    maybePageError: Option.none(),
    announcement: '',
    maybeEditingEvent: Option.none(),
    maybePendingScope: Option.none(),
    eventScope: 'thisOccurrence',
    isEventBusy: false,
    maybeEditorError: Option.none(),
    occasionEditingId: Option.none(),
    occasionTitle: '',
    occasionOriginDate: '',
    occasionYearly: true,
    occasionAdvance: '7',
    occasionAdvanceListbox: Listbox.init({
      id: 'calendar-occasion-advance-listbox',
    }),
    planningPriorityListboxes: [],
    maybeOccasionBusy: Option.none(),
    maybeOccasionError: Option.none(),
    occasionAnnouncement: '',
    picker: Picker.init({ id: 'calendar-picker' }),
  })

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

const occasionAdvanceListboxOutMessage = (inputs: Inputs) =>
  listboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (_model, value) => Message.SelectedOccasionAdvance({ value }),
  })

const calendarView = (model: Model, inputs: Inputs): CalendarView =>
  calendarViewOf({
    view: model.view,
    anchor: model.anchor,
    maybeSelectedDay: model.maybeSelectedDay,
    maybeServerWeek: model.maybeServerWeek,
    maybeServerMonth: model.maybeServerMonth,
    dirtyTaskIds: model.dirtyTaskIds,
    dirtyEventIds: model.dirtyEventIds,
    now: model.now,
    inputs,
  })

const planningPriorityListboxId = (taskId: string): string =>
  `calendar-planning-priority-${taskId}`

/** The row's priority picker, created closed the first time the row asks for it. */
export const planningPriorityListboxFor = (
  model: Model,
  taskId: string,
): Listbox.Model =>
  Option.getOrElse(
    Option.map(
      Array.findFirst(
        model.planningPriorityListboxes,
        entry => entry.taskId === taskId,
      ),
      entry => entry.listbox,
    ),
    () => Listbox.init({ id: planningPriorityListboxId(taskId) }),
  )

const writePlanningPriorityListbox = (
  model: Model,
  taskId: string,
  nextListbox: Listbox.Model,
): Model => {
  if (
    Array.some(
      model.planningPriorityListboxes,
      entry => entry.taskId === taskId,
    )
  ) {
    return modifyFields(model, {
      planningPriorityListboxes: () =>
        Array.map(model.planningPriorityListboxes, entry =>
          entry.taskId === taskId
            ? modifyFields(entry, { listbox: () => nextListbox })
            : entry,
        ),
    })
  }

  return modifyFields(model, {
    planningPriorityListboxes: () => [
      ...model.planningPriorityListboxes,
      PlanningPriorityListboxEntry.make({ taskId, listbox: nextListbox }),
    ],
  })
}

const planningPriorityOf = (value: string): Priority =>
  value === 'high' || value === 'low' ? value : 'medium'

const planningPriorityRowOf = (
  model: Model,
  inputs: Inputs,
  taskId: string,
): Option.Option<CalendarTaskItem> =>
  Array.findFirst(
    Array.flatMap(calendarView(model, inputs).week.days, day => day.tasks),
    item => item.id === taskId && !item.projected,
  )

const planningPriorityListboxOutMessage =
  (inputs: Inputs) => (taskId: string) =>
    optionalListboxOutMessageFold<
      Model,
      Message,
      OutMessage,
      LocalStoreService
    >({
      handleUpdate: (model, message) => update(model, message, inputs),
      toMessage: (model, value) =>
        Option.map(planningPriorityRowOf(model, inputs, taskId), row =>
          Message.ClickedPrioritizeCalendarTask({
            taskId,
            title: row.title,
            priority: planningPriorityOf(value),
            currentPriority: row.priority,
            projected: row.projected,
          }),
        ),
    })

const startFetch = (model: Model): CommandReturn => {
  const generation = model.refreshGeneration + 1
  const isWeek = model.view === 'week'

  const maybeEtag = isWeek
    ? Option.isSome(model.maybeServerWeek)
      ? model.maybeServerWeekEtag
      : Option.none()
    : Option.isSome(model.maybeServerMonth)
      ? model.maybeServerMonthEtag
      : Option.none()

  return {
    model: modifyFields(model, { refreshGeneration: () => generation }),
    commands: [
      FetchCalendar({
        view: model.view,
        anchor: model.anchor,
        maybeDay: model.maybeSelectedDay,
        maybeEtag,
        generation,
        dirtyAtRequest: model.dirtyTaskIds,
        dirtyEventsAtRequest: model.dirtyEventIds,
      }),
    ],
  }
}

const refreshIfSettled = (model: Model, inputs: Inputs): CommandReturn =>
  inputs.isOnline && inputs.pending === 0 ? startFetch(model) : { model }

const dropServerSnapshots = (model: Model): Model =>
  modifyFields(model, {
    maybeServerWeek: () => Option.none(),
    maybeServerWeekEtag: () => Option.none(),
    maybeServerMonth: () => Option.none(),
    maybeServerMonthEtag: () => Option.none(),
  })

const taskDraftOf = (model: Model, date: string): string =>
  Option.getOrElse(
    Array.findFirst(model.taskDrafts, draft => draft.date === date),
    () => ({ date, value: '' }),
  ).value

const withoutTaskDraft = (
  drafts: ReadonlyArray<CalendarTaskDraft>,
  date: string,
): ReadonlyArray<CalendarTaskDraft> =>
  Array.filter(drafts, draft => draft.date !== date)

const setTaskDraft = (
  drafts: ReadonlyArray<CalendarTaskDraft>,
  date: string,
  value: string,
): ReadonlyArray<CalendarTaskDraft> => [
  ...withoutTaskDraft(drafts, date),
  { date, value },
]

const defaultQuickEvent = (date: string): CalendarQuickEventDraft => ({
  date,
  title: '',
  allDay: true,
  startTime: '09:00',
  endTime: '10:00',
  open: false,
})

const quickEventOf = (model: Model, date: string): CalendarQuickEventDraft =>
  Option.getOrElse(
    Array.findFirst(model.quickEvents, draft => draft.date === date),
    () => defaultQuickEvent(date),
  )

const setQuickEvent = (
  drafts: ReadonlyArray<CalendarQuickEventDraft>,
  next: CalendarQuickEventDraft,
): ReadonlyArray<CalendarQuickEventDraft> => [
  ...Array.filter(drafts, draft => draft.date !== next.date),
  next,
]

const quickEventField = (
  model: Model,
  date: string,
  update: (draft: CalendarQuickEventDraft) => CalendarQuickEventDraft,
): ReadonlyArray<CalendarQuickEventDraft> =>
  setQuickEvent(model.quickEvents, update(quickEventOf(model, date)))

const seriesOf = (
  inputs: Inputs,
  occurrence: CalendarEventOccurrence,
): Option.Option<Event> =>
  Option.flatMap(
    Array.findFirst(inputs.mirror.events, row => row.id === occurrence.id),
    row =>
      Option.flatMap(inputs.maybeUserId, userId =>
        Option.flatMap(inputs.maybeHouseholdId, householdId =>
          Option.fromNullishOr(eventFromMirror(row, { userId, householdId })),
        ),
      ),
  )

const editorError = (model: Model, message: string): Model =>
  modifyFields(model, {
    maybeEditorError: () => Option.some(message),
    isEventBusy: () => false,
  })

const eventEditorFrom = (
  occurrence: CalendarEventOccurrence,
): CalendarEventEditorState =>
  CalendarEventEditorState.make({
    occurrence,
    draft: draftFromOccurrence(occurrence),
  })

const scopeAnnouncement = (
  action: CalendarScopeAction,
  scope: CalendarEditScope,
  title: string,
): string => {
  const following = scope === 'thisAndFollowing'

  if (action === 'edit') {
    return following
      ? `این رویداد و رویدادهای بعدی ویرایش شد: ${title}`
      : `رویداد ویرایش شد: ${title}`
  }

  return following
    ? `این رویداد و رویدادهای بعدی حذف شد: ${title}`
    : `رویداد حذف شد: ${title}`
}

const occasionToday = (model: Model, inputs: Inputs): string =>
  todayIn(inputs.display.timeZone, new Date(model.now))

const resetOccasionForm = (model: Model, today: string): Model =>
  modifyFields(model, {
    occasionEditingId: () => Option.none(),
    occasionTitle: () => '',
    occasionOriginDate: () => today,
    occasionYearly: () => true,
    occasionAdvance: () => '7',
    maybeOccasionError: () => Option.none(),
  })

const parsedAdvance = (value: string): Option.Option<number> => {
  if (value === '') {
    return Option.none()
  }

  const parsed = Number(value)

  return Number.isFinite(parsed)
    ? Option.some(Math.trunc(parsed))
    : Option.none()
}

const setEventEditorField = (
  model: Model,
  field: 'date' | 'startTime' | 'endTime',
  value: string,
): Model =>
  modifyFields(model, {
    maybeEditingEvent: () =>
      Option.map(model.maybeEditingEvent, editor =>
        modifyFields(editor, {
          draft: () =>
            Match.value(field).pipe(
              Match.when('date', () =>
                modifyFields(editor.draft, { date: () => value }),
              ),
              Match.when('startTime', () =>
                modifyFields(editor.draft, { startTime: () => value }),
              ),
              Match.orElse(() =>
                modifyFields(editor.draft, { endTime: () => value }),
              ),
            ),
        }),
      ),
  })

const applyPickerValue = (
  model: Model,
  target: string,
  value: string,
): Model => {
  if (target.startsWith('quick:')) {
    const [, date, field] = target.split(':')

    if (date === undefined || field === undefined) {
      return model
    }

    return modifyFields(model, {
      quickEvents: () =>
        quickEventField(model, date, draft =>
          field === 'startTime'
            ? { ...draft, startTime: value }
            : { ...draft, endTime: value },
        ),
    })
  }

  if (target === 'event:date') {
    return setEventEditorField(model, 'date', value)
  }

  if (target === 'event:startTime') {
    return setEventEditorField(model, 'startTime', value)
  }

  if (target === 'event:endTime') {
    return setEventEditorField(model, 'endTime', value)
  }

  if (target === 'occasion:originDate') {
    return modifyFields(model, { occasionOriginDate: () => value })
  }

  return model
}

const foldPicker = Picker.pickerFieldFold<Model, Message>({
  field: model => model.picker,
  setField: (model, nextPicker) =>
    modifyFields(model, { picker: () => nextPicker }),
  toParentMessage: message => Message.GotPickerMessage({ message }),
  applyValue: applyPickerValue,
})

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn => {
  const foldOccasionAdvanceListbox = Update.foldChild({
    update: OccasionAdvanceListbox.update,
    read: (model: Model) => Option.some(model.occasionAdvanceListbox),
    write: (model: Model, nextListbox: Listbox.Model) =>
      modifyFields(model, { occasionAdvanceListbox: () => nextListbox }),
    toParentMessage: message =>
      Message.GotOccasionAdvanceListboxMessage({ message }),
    foldOutMessage: occasionAdvanceListboxOutMessage(inputs),
  })

  const foldPlanningPriorityListbox = Update.foldChildAt({
    update: PlanningPriorityListbox.update,
    readAt: (planModel: Model, taskId: string) =>
      Option.some(planningPriorityListboxFor(planModel, taskId)),
    writeAt: writePlanningPriorityListbox,
    toParentMessage: (taskId, message) =>
      Message.GotPlanningPriorityListboxMessage({ taskId, message }),
    foldOutMessage: planningPriorityListboxOutMessage(inputs),
  })

  return Message.match<UpdateReturn>(message, {
    GotPickerMessage: ({ message: pickerMessage }) =>
      foldPicker(model, pickerMessage),

    TickedCalendar: ({ now }) => {
      const next = modifyFields(model, { now: () => now })

      const seeded =
        model.occasionOriginDate === ''
          ? modifyFields(next, {
              occasionOriginDate: () => occasionToday(next, inputs),
            })
          : next

      return refreshIfSettled(seeded, inputs)
    },

    WentOnline: () => {
      const next = modifyFields(model, {
        fetchState: () => CalendarFetchState.Idle(),
      })

      return inputs.pending === 0 ? startFetch(next) : { model: next }
    },

    WentOffline: () => ({
      model: modifyFields(dropServerSnapshots(model), {
        fetchState: () => CalendarFetchState.Offline(),
      }),
    }),

    SucceededFetchWeek: ({
      generation,
      model: server,
      maybeEtag,
      dirtyAtRequest,
      dirtyEventsAtRequest,
    }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      if (!inputs.isOnline || inputs.pending > 0) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerWeek: () => Option.some(server),
          maybeServerWeekEtag: () => maybeEtag,
          fetchState: () => CalendarFetchState.Ready(),
          dirtyTaskIds: () =>
            Array.filter(
              model.dirtyTaskIds,
              id => !Array.contains(dirtyAtRequest, id),
            ),
          dirtyEventIds: () =>
            Array.filter(
              model.dirtyEventIds,
              id => !Array.contains(dirtyEventsAtRequest, id),
            ),
        }),
      }
    },

    UnchangedFetchWeek: ({ generation, maybeEtag }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerWeekEtag: () => maybeEtag,
          fetchState: () => CalendarFetchState.Ready(),
        }),
      }
    },

    FailedFetchWeek: ({ generation, failure }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerWeek: () => Option.none(),
          maybeServerWeekEtag: () => Option.none(),
          fetchState: () =>
            failure.code === 'Network'
              ? CalendarFetchState.Offline()
              : CalendarFetchState.Error(),
        }),
      }
    },

    SucceededFetchMonth: ({
      generation,
      model: server,
      maybeEtag,
      dirtyAtRequest,
      dirtyEventsAtRequest,
    }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      if (!inputs.isOnline || inputs.pending > 0) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerMonth: () => Option.some(server),
          maybeServerMonthEtag: () => maybeEtag,
          fetchState: () => CalendarFetchState.Ready(),
          dirtyTaskIds: () =>
            Array.filter(
              model.dirtyTaskIds,
              id => !Array.contains(dirtyAtRequest, id),
            ),
          dirtyEventIds: () =>
            Array.filter(
              model.dirtyEventIds,
              id => !Array.contains(dirtyEventsAtRequest, id),
            ),
        }),
      }
    },

    UnchangedFetchMonth: ({ generation, maybeEtag }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerMonthEtag: () => maybeEtag,
          fetchState: () => CalendarFetchState.Ready(),
        }),
      }
    },

    FailedFetchMonth: ({ generation, failure }) => {
      if (generation !== model.refreshGeneration) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeServerMonth: () => Option.none(),
          maybeServerMonthEtag: () => Option.none(),
          fetchState: () =>
            failure.code === 'Network'
              ? CalendarFetchState.Offline()
              : CalendarFetchState.Error(),
        }),
      }
    },

    SelectedCalendarView: ({ view }) => {
      if (model.view === view) {
        return { model }
      }

      const next = modifyFields(model, { view: () => view })

      return refreshIfSettled(next, inputs)
    },

    PressedPreviousWeek: () => {
      const view = calendarView(model, inputs)

      const next = modifyFields(model, {
        anchor: () => shiftDay(view.week.start, -7),
      })

      return refreshIfSettled(next, inputs)
    },

    PressedNextWeek: () => {
      const view = calendarView(model, inputs)

      const next = modifyFields(model, {
        anchor: () => shiftDay(view.week.start, 7),
      })

      return refreshIfSettled(next, inputs)
    },

    PressedTodayWeek: () => {
      const next = modifyFields(model, {
        anchor: () => todayIn(inputs.display.timeZone, new Date(model.now)),
      })

      return refreshIfSettled(next, inputs)
    },

    PressedPreviousMonth: () => {
      const next = modifyFields(model, {
        maybeSelectedDay: () => Option.none(),
        anchor: () => shiftMonth(model.anchor, -1),
      })

      return refreshIfSettled(next, inputs)
    },

    PressedNextMonth: () => {
      const next = modifyFields(model, {
        maybeSelectedDay: () => Option.none(),
        anchor: () => shiftMonth(model.anchor, 1),
      })

      return refreshIfSettled(next, inputs)
    },

    PressedTodayMonth: () => {
      const next = modifyFields(model, {
        maybeSelectedDay: () => Option.none(),
        anchor: () => todayIn(inputs.display.timeZone, new Date(model.now)),
      })

      return refreshIfSettled(next, inputs)
    },

    SelectedCalendarDay: ({ date }) => {
      if (Option.contains(model.maybeSelectedDay, date)) {
        return { model }
      }

      const next = modifyFields(model, {
        maybeSelectedDay: () => Option.some(date),
      })

      return refreshIfSettled(next, inputs)
    },

    ClosedCalendarDay: () => {
      const next = modifyFields(model, {
        maybeSelectedDay: () => Option.none(),
      })

      return refreshIfSettled(next, inputs)
    },

    OpenedDayInWeek: ({ date }) => {
      const next = modifyFields(model, {
        anchor: () => date,
        maybeSelectedDay: () => Option.none(),
        planningOpen: () => false,
        view: () => 'week',
      })

      return refreshIfSettled(next, inputs)
    },

    ClickedTogglePlanning: () => ({
      model: modifyFields(model, {
        planningOpen: () => !model.planningOpen,
      }),
    }),

    UpdatedTaskDraft: ({ date, value }) => ({
      model: modifyFields(model, {
        taskDrafts: () => setTaskDraft(model.taskDrafts, date, value),
      }),
    }),

    SubmittedTaskQuickAdd: ({ date }) => {
      const title = taskDraftOf(model, date).trim()

      if (
        !inputs.isStoreReady ||
        title === '' ||
        Option.contains(model.maybeBusyKey, `add:${date}`)
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeBusyKey: () => Option.some(`add:${date}`),
          maybePageError: () => Option.none(),
        }),
        commands: [
          CreateCalendarTask({
            title,
            date,
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    CompletedCreateCalendarTask: ({ taskId, title, date }) => ({
      model: modifyFields(model, {
        maybeBusyKey: () => Option.none(),
        maybePageError: () => Option.none(),
        taskDrafts: () => withoutTaskDraft(model.taskDrafts, date),
        announcement: () =>
          `کار تازه برای ${dayLabel(date, inputs.display.digits)}: ${title}`,
        dirtyTaskIds: () => [...model.dirtyTaskIds, taskId],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateCalendarTask: ({ message }) => ({
      model: modifyFields(model, {
        maybeBusyKey: () => Option.none(),
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedCompleteCalendarTask: ({ taskId, title, projected }) => {
      if (projected || !inputs.isStoreReady) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeBusyKey: () => Option.some(`done:${taskId}`),
          maybePageError: () => Option.none(),
        }),
        commands: [CompleteCalendarTask({ taskId, title })],
      }
    },

    CompletedCompleteCalendarTask: ({ taskId, title }) => ({
      model: modifyFields(model, {
        maybeBusyKey: () => Option.none(),
        announcement: () => `انجام شد: ${title}`,
        dirtyTaskIds: () => [...model.dirtyTaskIds, taskId],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCompleteCalendarTask: ({ message }) => ({
      model: modifyFields(model, {
        maybeBusyKey: () => Option.none(),
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedPrioritizeCalendarTask: ({
      taskId,
      title,
      priority,
      currentPriority,
      projected,
    }) => {
      if (projected || !inputs.isStoreReady || priority === currentPriority) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybePageError: () => Option.none(),
        }),
        commands: [PrioritizeCalendarTask({ taskId, title, priority })],
      }
    },

    CompletedPrioritizeCalendarTask: ({ taskId, title, priority }) => ({
      model: modifyFields(model, {
        announcement: () => `اولویت ${title}: ${PRIORITY_LABELS[priority]}`,
        dirtyTaskIds: () => [...model.dirtyTaskIds, taskId],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedPrioritizeCalendarTask: ({ message }) => ({
      model: modifyFields(model, {
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedMoveCalendarTask: ({ taskId, title, date, days, projected }) => {
      if (projected || !inputs.isStoreReady) {
        return { model }
      }

      const target = shiftDay(date, days)

      return {
        model: modifyFields(model, { maybePageError: () => Option.none() }),
        commands: [
          MoveCalendarTask({
            taskId,
            title,
            target,
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    CompletedMoveCalendarTask: ({ taskId, title, target }) => ({
      model: modifyFields(model, {
        announcement: () =>
          `${title} به ${dayLabel(target, inputs.display.digits)} منتقل شد`,
        dirtyTaskIds: () => [...model.dirtyTaskIds, taskId],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedMoveCalendarTask: ({ message }) => ({
      model: modifyFields(model, {
        maybePageError: () => Option.some(message),
      }),
    }),

    ToggledEventQuickAdd: ({ date, isOpen }) => ({
      model: modifyFields(model, {
        quickEvents: () =>
          quickEventField(model, date, draft => ({ ...draft, open: isOpen })),
      }),
    }),

    UpdatedQuickEventTitle: ({ date, value }) => ({
      model: modifyFields(model, {
        quickEvents: () =>
          quickEventField(model, date, draft => ({ ...draft, title: value })),
      }),
    }),

    ToggledQuickEventAllDay: ({ date, allDay }) => ({
      model: modifyFields(model, {
        quickEvents: () =>
          quickEventField(model, date, draft => ({ ...draft, allDay })),
      }),
    }),

    UpdatedQuickEventStart: ({ date, value }) => ({
      model: modifyFields(model, {
        quickEvents: () =>
          quickEventField(model, date, draft => ({
            ...draft,
            startTime: value,
          })),
      }),
    }),

    UpdatedQuickEventEnd: ({ date, value }) => ({
      model: modifyFields(model, {
        quickEvents: () =>
          quickEventField(model, date, draft => ({ ...draft, endTime: value })),
      }),
    }),

    SubmittedEventQuickAdd: ({ date }) => {
      const draft = quickEventOf(model, date)
      const title = draft.title.trim()

      if (!inputs.isStoreReady || title === '' || model.isEventBusy) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isEventBusy: () => true,
          maybePageError: () => Option.none(),
        }),
        commands: [
          CreateCalendarEvent({
            draft: {
              title,
              date: draft.date,
              allDay: draft.allDay,
              startTime: draft.startTime,
              endTime: draft.endTime,
            },
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    CompletedCreateCalendarEvent: ({ eventId, title, date }) => ({
      model: modifyFields(model, {
        isEventBusy: () => false,
        maybePageError: () => Option.none(),
        quickEvents: () =>
          setQuickEvent(model.quickEvents, defaultQuickEvent(date)),
        announcement: () =>
          `رویداد تازه برای ${dayLabel(date, inputs.display.digits)}: ${title}`,
        dirtyEventIds: () => [...model.dirtyEventIds, eventId],
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateCalendarEvent: ({ message }) => ({
      model: modifyFields(model, {
        isEventBusy: () => false,
        maybePageError: () => Option.some(message),
      }),
    }),

    OpenedEventEditor: ({ occurrence }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () => Option.some(eventEditorFrom(occurrence)),
        maybePendingScope: () => Option.none(),
        maybeEditorError: () => Option.none(),
      }),
      commands: [FocusEventEditor()],
    }),

    ClosedEventEditor: () => ({
      model: modifyFields(model, {
        maybeEditingEvent: () => Option.none(),
        maybePendingScope: () => Option.none(),
        maybeEditorError: () => Option.none(),
      }),
    }),

    CompletedFocusEventEditor: () => ({ model }),

    UpdatedEventEditorTitle: ({ value }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () =>
          Option.map(model.maybeEditingEvent, editor =>
            modifyFields(editor, {
              draft: () => modifyFields(editor.draft, { title: () => value }),
            }),
          ),
      }),
    }),

    ToggledEventEditorAllDay: ({ allDay }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () =>
          Option.map(model.maybeEditingEvent, editor =>
            modifyFields(editor, {
              draft: () => modifyFields(editor.draft, { allDay: () => allDay }),
            }),
          ),
      }),
    }),

    UpdatedEventEditorDate: ({ value }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () =>
          Option.map(model.maybeEditingEvent, editor =>
            modifyFields(editor, {
              draft: () => modifyFields(editor.draft, { date: () => value }),
            }),
          ),
      }),
    }),

    UpdatedEventEditorStart: ({ value }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () =>
          Option.map(model.maybeEditingEvent, editor =>
            modifyFields(editor, {
              draft: () =>
                modifyFields(editor.draft, { startTime: () => value }),
            }),
          ),
      }),
    }),

    UpdatedEventEditorEnd: ({ value }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () =>
          Option.map(model.maybeEditingEvent, editor =>
            modifyFields(editor, {
              draft: () => modifyFields(editor.draft, { endTime: () => value }),
            }),
          ),
      }),
    }),

    SubmittedEventEditor: () => {
      if (Option.isNone(model.maybeEditingEvent)) {
        return { model }
      }

      const editor = model.maybeEditingEvent.value
      const title = editor.draft.title.trim()
      const draft = { ...editor.draft, title }

      if (
        !inputs.isStoreReady ||
        model.isEventBusy ||
        title === '' ||
        draft.date === ''
      ) {
        return { model }
      }

      const maybeSeries = seriesOf(inputs, editor.occurrence)

      if (Option.isNone(maybeSeries)) {
        return { model: editorError(model, EVENT_MISSING_COPY) }
      }

      if (maybeSeries.value.recurrence !== null) {
        return {
          model: modifyFields(model, {
            maybePendingScope: () =>
              Option.some({
                action: 'edit',
                occurrence: editor.occurrence,
                maybeDraft: Option.some(draft),
                maybeIds: Option.none(),
              }),
            eventScope: () => 'thisOccurrence',
            maybeEditorError: () => Option.none(),
          }),
          commands: [GenerateEventScopeIds(), FocusScopePrompt()],
        }
      }

      return {
        model: modifyFields(model, {
          isEventBusy: () => true,
          maybeEditorError: () => Option.none(),
        }),
        commands: [
          CommitCalendarEventScope({
            occurrence: editor.occurrence,
            action: 'edit',
            scope: 'thisOccurrence',
            maybeDraft: Option.some(draft),
            maybeIds: Option.none(),
            isOnline: inputs.isOnline,
            maybeUserId: inputs.maybeUserId,
            maybeHouseholdId: inputs.maybeHouseholdId,
          }),
        ],
      }
    },

    ClickedToggleEventVisibility: () => {
      if (Option.isNone(model.maybeEditingEvent)) {
        return { model }
      }

      const editor = model.maybeEditingEvent.value
      const maybeSeries = seriesOf(inputs, editor.occurrence)

      if (
        Option.isNone(maybeSeries) ||
        !Option.contains(inputs.maybeUserId, maybeSeries.value.ownerId)
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeEditorError: () => Option.none(),
        }),
        commands: [
          SetCalendarEventVisibility({
            eventId: editor.occurrence.id,
            visibility:
              maybeSeries.value.visibility === 'shared' ? 'private' : 'shared',
          }),
        ],
      }
    },

    CompletedSetEventVisibility: ({ visibility }) => ({
      model: modifyFields(model, {
        announcement: () =>
          visibility === 'shared'
            ? 'رویداد با خانه به اشتراک گذاشته شد'
            : 'رویداد خصوصی شد',
        maybeEditorError: () => Option.none(),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetEventVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybeEditorError: () => Option.some(message),
      }),
    }),

    ClickedDeleteEvent: () => {
      if (Option.isNone(model.maybeEditingEvent)) {
        return { model }
      }

      const editor = model.maybeEditingEvent.value
      const maybeSeries = seriesOf(inputs, editor.occurrence)

      if (Option.isNone(maybeSeries)) {
        return { model: editorError(model, EVENT_MISSING_COPY) }
      }

      if (maybeSeries.value.recurrence !== null) {
        return {
          model: modifyFields(model, {
            maybePendingScope: () =>
              Option.some({
                action: 'delete',
                occurrence: editor.occurrence,
                maybeDraft: Option.none(),
                maybeIds: Option.none(),
              }),
            eventScope: () => 'thisOccurrence',
            maybeEditorError: () => Option.none(),
          }),
          commands: [GenerateEventScopeIds(), FocusScopePrompt()],
        }
      }

      return {
        model: modifyFields(model, {
          isEventBusy: () => true,
          maybeEditorError: () => Option.none(),
        }),
        commands: [
          CommitCalendarEventScope({
            occurrence: editor.occurrence,
            action: 'delete',
            scope: 'thisOccurrence',
            maybeDraft: Option.none(),
            maybeIds: Option.none(),
            isOnline: inputs.isOnline,
            maybeUserId: inputs.maybeUserId,
            maybeHouseholdId: inputs.maybeHouseholdId,
          }),
        ],
      }
    },

    CompletedGenerateEventScopeIds: ({ ids }) => ({
      model: modifyFields(model, {
        maybePendingScope: () =>
          Option.map(model.maybePendingScope, pending => ({
            ...pending,
            maybeIds: Option.some(ids),
          })),
      }),
    }),

    SelectedEventScope: ({ scope }) => ({
      model: modifyFields(model, { eventScope: () => scope }),
    }),

    PressedConfirmEventScope: () => {
      if (Option.isNone(model.maybePendingScope) || model.isEventBusy) {
        return { model }
      }

      const pending = model.maybePendingScope.value

      if (Option.isNone(pending.maybeIds)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isEventBusy: () => true,
          maybeEditorError: () => Option.none(),
        }),
        commands: [
          CommitCalendarEventScope({
            occurrence: pending.occurrence,
            action: pending.action,
            scope: model.eventScope,
            maybeDraft: pending.maybeDraft,
            maybeIds: pending.maybeIds,
            isOnline: inputs.isOnline,
            maybeUserId: inputs.maybeUserId,
            maybeHouseholdId: inputs.maybeHouseholdId,
          }),
        ],
      }
    },

    PressedCancelEventScope: () => ({
      model: modifyFields(model, {
        maybePendingScope: () => Option.none(),
        maybeEditorError: () => Option.none(),
      }),
      commands: [FocusEventEditor()],
    }),

    CompletedFocusScopePrompt: () => ({ model }),

    CompletedCommitEventScope: ({
      action,
      scope,
      seriesId,
      maybeFollowingId,
      title,
    }) => ({
      model: modifyFields(model, {
        maybeEditingEvent: () => Option.none(),
        maybePendingScope: () => Option.none(),
        eventScope: () => 'thisOccurrence',
        isEventBusy: () => false,
        maybeEditorError: () => Option.none(),
        announcement: () => scopeAnnouncement(action, scope, title),
        dirtyEventIds: () =>
          Option.match(maybeFollowingId, {
            onNone: () => [...model.dirtyEventIds, seriesId],
            onSome: followingId => [
              ...model.dirtyEventIds,
              seriesId,
              followingId,
            ],
          }),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCommitEventScope: ({ message }) => ({
      model: editorError(model, message),
    }),

    PressedEscape: () => {
      if (Option.isSome(model.maybePendingScope)) {
        return {
          model: modifyFields(model, {
            maybePendingScope: () => Option.none(),
            maybeEditorError: () => Option.none(),
          }),
          commands: [FocusEventEditor()],
        }
      }

      return Option.isSome(model.maybeEditingEvent)
        ? {
            model: modifyFields(model, {
              maybeEditingEvent: () => Option.none(),
              maybeEditorError: () => Option.none(),
            }),
          }
        : { model }
    },

    UpdatedOccasionTitle: ({ value }) => ({
      model: modifyFields(model, { occasionTitle: () => value }),
    }),

    UpdatedOccasionOriginDate: ({ value }) => ({
      model: modifyFields(model, { occasionOriginDate: () => value }),
    }),

    ToggledOccasionYearly: ({ yearly }) => ({
      model: modifyFields(model, { occasionYearly: () => yearly }),
    }),

    SelectedOccasionAdvance: ({ value }) => ({
      model: modifyFields(model, { occasionAdvance: () => value }),
    }),

    SubmittedOccasion: () => {
      const title = model.occasionTitle.trim()

      if (
        !inputs.isStoreReady ||
        Option.isSome(model.maybeOccasionBusy) ||
        title === '' ||
        model.occasionOriginDate === ''
      ) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeOccasionBusy: () => Option.some('save'),
          maybeOccasionError: () => Option.none(),
        }),
        commands: [
          SaveCalendarOccasion({
            maybeEditingId: model.occasionEditingId,
            title,
            originDate: model.occasionOriginDate,
            yearly: model.occasionYearly,
            maybeAdvanceDays: parsedAdvance(model.occasionAdvance),
            timeZone: inputs.display.timeZone,
          }),
        ],
      }
    },

    ClickedEditOccasion: ({ occasionId }) =>
      Option.match(
        Array.findFirst(
          inputs.mirror.occasions,
          (occasion: OccasionRow) => occasion.id === occasionId,
        ),
        {
          onNone: () => ({ model }),
          onSome: occasion => ({
            model: modifyFields(model, {
              occasionEditingId: () => Option.some(occasion.id),
              occasionTitle: () => occasion.title,
              occasionOriginDate: () => occasion.originDate,
              occasionYearly: () => occasion.yearly,
              occasionAdvance: () =>
                occasion.advanceReminderDays === null
                  ? ''
                  : String(occasion.advanceReminderDays),
              maybeOccasionError: () => Option.none(),
            }),
          }),
        },
      ),

    ClickedToggleOccasionVisibility: () =>
      Option.match(model.occasionEditingId, {
        onNone: () => ({ model }),
        onSome: occasionId =>
          Option.match(
            Array.findFirst(
              inputs.mirror.occasions,
              (occasion: OccasionRow) => occasion.id === occasionId,
            ),
            {
              onNone: () => ({ model }),
              onSome: occasion =>
                Option.contains(inputs.maybeUserId, occasion.ownerId)
                  ? {
                      model: modifyFields(model, {
                        maybeOccasionError: () => Option.none(),
                      }),
                      commands: [
                        SetCalendarOccasionVisibility({
                          occasionId,
                          visibility:
                            occasion.visibility === 'shared'
                              ? 'private'
                              : 'shared',
                        }),
                      ],
                    }
                  : { model },
            },
          ),
      }),

    CompletedSetOccasionVisibility: ({ visibility }) => ({
      model: modifyFields(model, {
        occasionAnnouncement: () =>
          visibility === 'shared'
            ? 'مناسبت با خانه به اشتراک گذاشته شد'
            : 'مناسبت خصوصی شد',
        maybeOccasionError: () => Option.none(),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetOccasionVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybeOccasionError: () => Option.some(message),
      }),
    }),

    ClickedCancelOccasionEdit: () => ({
      model: resetOccasionForm(model, occasionToday(model, inputs)),
    }),

    CompletedSaveOccasion: ({ title, isEdit }) => ({
      model: modifyFields(
        resetOccasionForm(model, occasionToday(model, inputs)),
        {
          maybeOccasionBusy: () => Option.none(),
          maybeOccasionError: () => Option.none(),
          occasionAnnouncement: () =>
            isEdit
              ? `مناسبت «${title}» ویرایش شد`
              : `مناسبت «${title}» افزوده شد`,
        },
      ),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSaveOccasion: ({ message }) => ({
      model: modifyFields(model, {
        maybeOccasionBusy: () => Option.none(),
        maybeOccasionError: () => Option.some(message),
      }),
    }),

    ClickedDeleteOccasion: ({ occasionId, title }) => {
      if (Option.isSome(model.maybeOccasionBusy)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeOccasionBusy: () => Option.some(`delete:${occasionId}`),
          maybeOccasionError: () => Option.none(),
        }),
        commands: [DeleteCalendarOccasion({ occasionId, title })],
      }
    },

    CompletedDeleteOccasion: ({ occasionId, title }) => {
      const next = modifyFields(model, {
        maybeOccasionBusy: () => Option.none(),
        occasionAnnouncement: () => `مناسبت «${title}» حذف شد`,
        occasionEditingId: () =>
          Option.contains(model.occasionEditingId, occasionId)
            ? Option.none()
            : model.occasionEditingId,
      })

      return {
        model: Option.contains(model.occasionEditingId, occasionId)
          ? resetOccasionForm(next, occasionToday(model, inputs))
          : next,
        outMessage: OutMessage.WroteLocalData(),
      }
    },

    FailedDeleteOccasion: ({ message }) => ({
      model: modifyFields(model, {
        maybeOccasionBusy: () => Option.none(),
        maybeOccasionError: () => Option.some(message),
      }),
    }),

    ClickedPrepareOccasion: ({ occasionId }) => {
      if (Option.isSome(model.maybeOccasionBusy)) {
        return { model }
      }

      return Option.match(
        Array.findFirst(
          inputs.mirror.occasions,
          (occasion: OccasionRow) => occasion.id === occasionId,
        ),
        {
          onNone: () => ({ model }),
          onSome: occasion => ({
            model: modifyFields(model, {
              maybeOccasionBusy: () => Option.some(`prepare:${occasionId}`),
              maybeOccasionError: () => Option.none(),
            }),
            commands: [
              PrepareCalendarOccasionTask({
                occasion,
                today: occasionToday(model, inputs),
              }),
            ],
          }),
        },
      )
    },

    CompletedPrepareOccasion: ({ title, created }) => ({
      model: modifyFields(model, {
        maybeOccasionBusy: () => Option.none(),
        maybeOccasionError: () => Option.none(),
        occasionAnnouncement: () =>
          created
            ? `کار آماده‌سازی برای «${title}» ساخته شد`
            : `کار آماده‌سازی «${title}» از قبل ساخته شده است`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedPrepareOccasion: ({ noUpcomingOccurrence, message }) => ({
      model: modifyFields(model, {
        maybeOccasionBusy: () => Option.none(),
        maybeOccasionError: () =>
          Option.some(
            noUpcomingOccurrence
              ? 'برای این مناسبت تاریخ بعدی وجود ندارد'
              : message,
          ),
      }),
    }),

    GotOccasionAdvanceListboxMessage: ({ message }) =>
      foldOccasionAdvanceListbox(model, message),

    GotPlanningPriorityListboxMessage: ({ taskId, message }) =>
      foldPlanningPriorityListbox(model, taskId, message),
  })
}

/** Entry capability the root folds; resets the transient screen state. */
export const entered = (model: Model, inputs: Inputs): CommandReturn => {
  const today = occasionToday(model, inputs)

  return {
    model: modifyFields(model, {
      view: () => 'week',
      anchor: () => today,
      maybeSelectedDay: () => Option.none(),
      planningOpen: () => false,
      fetchState: () => CalendarFetchState.Idle(),
      refreshGeneration: () => model.refreshGeneration + 1,
      dirtyTaskIds: () => [],
      dirtyEventIds: () => [],
      taskDrafts: () => [],
      quickEvents: () => [],
      maybeBusyKey: () => Option.none(),
      maybePageError: () => Option.none(),
      announcement: () => '',
      maybeEditingEvent: () => Option.none(),
      maybePendingScope: () => Option.none(),
      eventScope: () => 'thisOccurrence',
      isEventBusy: () => false,
      maybeEditorError: () => Option.none(),
      occasionEditingId: () => Option.none(),
      occasionTitle: () => '',
      occasionOriginDate: () => today,
      occasionYearly: () => true,
      occasionAdvance: () => '7',
      occasionAdvanceListbox: () =>
        Listbox.init({ id: 'calendar-occasion-advance-listbox' }),
      planningPriorityListboxes: () => [],
      maybeOccasionBusy: () => Option.none(),
      maybeOccasionError: () => Option.none(),
      occasionAnnouncement: () => '',
    }),
    commands: [ReadCalendarClock()],
  }
}

/** A completed drain is the moment the read model can be revalidated. */
export const syncSettled = (model: Model, inputs: Inputs): CommandReturn =>
  refreshIfSettled(model, inputs)

// SUBSCRIPTION

const onlineStream = onlineEvents<Message>({
  onOnline: () => Message.WentOnline(),
  onOffline: () => Message.WentOffline(),
})

const keyboardEvents: Stream.Stream<Message> = eventStream(emit => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      emit(Message.PressedEscape())
    }
  }

  document.addEventListener('keydown', onKeyDown)

  return () => {
    document.removeEventListener('keydown', onKeyDown)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  calendarClock: Subscription.persistentEntry(
    clockEvents(now => Message.TickedCalendar({ now })),
  ),
  calendarOnline: Subscription.persistentEntry(onlineStream),
  calendarKeyboard: Subscription.persistentEntry(keyboardEvents),
}))

// VIEW

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => calendarPageView(model, inputs, h),
)
