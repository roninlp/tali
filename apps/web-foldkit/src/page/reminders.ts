import { Array, Effect, Option, Schema, Stream } from 'effect'
import { Command, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Listbox } from '@foldkit/ui'

import {
  ReminderActionMessage,
  flushQueuedReminderActions,
  respondToDispatch,
} from '../lib/push/notification-actions'
import {
  DispatchResponse,
  ReminderFailure,
  ReminderInboxItem,
  fetchReminderInbox,
  respondToReminder,
} from '../lib/reminders/api'
import { setVisibilityInMirror } from '../lib/visibility-writes'
import type { LocalStoreService } from '../sync/local-store'
import { eventStream, visibilityEvents } from '../ui/dom-stream'
import { listboxOutMessageFold } from '../ui/fold'
import { localWrite } from './local-write'
import {
  DEFAULT_SNOOZE_MINUTES,
  isSnoozePreset,
  reminderFailureCopy,
} from './reminders-model'
import { remindersPageView } from './reminders-view'

/**
 * The `/reminders` missed-reminder inbox Submodel, ported from
 * `apps/web/src/components/reminder-inbox.tsx` (ticket #61; FR-REM-02/03).
 *
 * The inbox is a ledger query, not a job: every fire writes a dispatch row at
 * claim time, so a reminder the browser never saw is here on the next open with
 * the same Done/Snooze/Dismiss affordances as the notification. Opening the
 * screen also drains the service worker's queued Done/Snooze taps through the
 * existing respond route, then re-reads the ledger so an answered reminder
 * disappears instead of showing up as missed.
 */

// MODEL

export type SnoozeOption = Readonly<{ value: string; label: string }>

export const SnoozeListboxEntry = Schema.Struct({
  dispatchId: Schema.String,
  listbox: Listbox.Model,
})

export type SnoozeListboxEntry = typeof SnoozeListboxEntry.Type

export const SnoozeListbox = Listbox.create<SnoozeOption, string>()

export const Model = Schema.Struct({
  items: Schema.Array(ReminderInboxItem),
  isHistory: Schema.Boolean,
  isLoading: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
  maybeBusyDispatchId: Schema.Option(Schema.String),
  snoozeMinutes: Schema.Int,
  snoozeListboxes: Schema.Array(SnoozeListboxEntry),
  fetchGeneration: Schema.Int,
})

export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    items: [],
    isHistory: false,
    isLoading: false,
    maybeError: Option.none(),
    maybeBusyDispatchId: Option.none(),
    snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
    snoozeListboxes: [],
    fetchGeneration: 0,
  })

// MESSAGE

export const Message = defineMessageUnion({
  ChangedVisibility: { isVisible: Schema.Boolean },
  ReceivedReminderAction: {},
  ClickedToggleHistory: {},
  ChangedSnoozeMinutes: { minutes: Schema.Int },
  GotSnoozeListboxMessage: {
    dispatchId: Schema.String,
    message: Listbox.Message,
  },
  ClickedToggleReminderVisibility: {
    reminderId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  CompletedSetReminderVisibility: {
    reminderId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetReminderVisibility: { message: Schema.String },
  ClickedRespond: {
    dispatchId: Schema.String,
    response: DispatchResponse,
  },
  CompletedFetchInbox: {
    generation: Schema.Int,
    items: Schema.Array(ReminderInboxItem),
  },
  FailedFetchInbox: {
    generation: Schema.Int,
    failure: ReminderFailure,
  },
  CompletedDrainQueueAndFetchInbox: {
    generation: Schema.Int,
    items: Schema.Array(ReminderInboxItem),
  },
  FailedDrainQueueAndFetchInbox: {
    generation: Schema.Int,
    failure: ReminderFailure,
  },
  CompletedRespondToReminder: { dispatchId: Schema.String },
  FailedRespondToReminder: {
    dispatchId: Schema.String,
    failure: ReminderFailure,
  },
})

export type Message = typeof Message.Type

// COMMAND

export const FetchInbox = Command.define('FetchInbox', {
  args: { generation: Schema.Int, history: Schema.Boolean },
  messages: [Message.CompletedFetchInbox, Message.FailedFetchInbox],
  execute: ({ generation, history }) =>
    fetchReminderInbox({ history }).pipe(
      Effect.map(result =>
        result.ok
          ? Message.CompletedFetchInbox({ generation, items: result.value })
          : Message.FailedFetchInbox({ generation, failure: result.error }),
      ),
    ),
})

/**
 * Post every queued notification answer, then re-read the ledger. The queue is
 * a device convenience; a drain failure leaves the records for the next open
 * and the ledger read still runs.
 */
export const DrainQueueAndFetchInbox = Command.define(
  'DrainQueueAndFetchInbox',
  {
    args: { generation: Schema.Int, history: Schema.Boolean },
    messages: [
      Message.CompletedDrainQueueAndFetchInbox,
      Message.FailedDrainQueueAndFetchInbox,
    ],
    execute: ({ generation, history }) =>
      Effect.gen(function* () {
        yield* flushQueuedReminderActions(respondToDispatch).pipe(Effect.ignore)
        const result = yield* fetchReminderInbox({ history })

        return result.ok
          ? Message.CompletedDrainQueueAndFetchInbox({
              generation,
              items: result.value,
            })
          : Message.FailedDrainQueueAndFetchInbox({
              generation,
              failure: result.error,
            })
      }),
  },
)

export const SetReminderVisibility = Command.define('SetReminderVisibility', {
  args: {
    reminderId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  messages: [
    Message.CompletedSetReminderVisibility,
    Message.FailedSetReminderVisibility,
  ],
  execute: ({ reminderId, visibility }) =>
    localWrite({
      run: (store, now) =>
        setVisibilityInMirror(store, 'reminder', reminderId, visibility, now),
      onSuccess: () =>
        Message.CompletedSetReminderVisibility({ reminderId, visibility }),
      onFailure: message => Message.FailedSetReminderVisibility({ message }),
    }),
})

export const RespondToReminder = Command.define('RespondToReminder', {
  args: {
    dispatchId: Schema.String,
    response: DispatchResponse,
    maybeSnoozeMinutes: Schema.Option(Schema.Int),
  },
  messages: [
    Message.CompletedRespondToReminder,
    Message.FailedRespondToReminder,
  ],
  execute: ({ dispatchId, response, maybeSnoozeMinutes }) =>
    respondToReminder(
      Option.match(maybeSnoozeMinutes, {
        onNone: () => ({ dispatchId, response }),
        onSome: snoozeMinutes => ({ dispatchId, response, snoozeMinutes }),
      }),
    ).pipe(
      Effect.map(result =>
        result.ok
          ? Message.CompletedRespondToReminder({ dispatchId })
          : Message.FailedRespondToReminder({
              dispatchId,
              failure: result.error,
            }),
      ),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: initialModel(),
})

// UPDATE

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  import('../sync/local-store').LocalStoreService
>

const snoozeListboxId = (dispatchId: string): string =>
  `reminder-snooze-${dispatchId}`

/** The row's snooze picker, created closed the first time the row asks for it. */
export const snoozeListboxFor = (
  model: Model,
  dispatchId: string,
): Listbox.Model =>
  Option.getOrElse(
    Option.map(
      Array.findFirst(
        model.snoozeListboxes,
        entry => entry.dispatchId === dispatchId,
      ),
      entry => entry.listbox,
    ),
    () => Listbox.init({ id: snoozeListboxId(dispatchId) }),
  )

const writeSnoozeListbox = (
  model: Model,
  dispatchId: string,
  nextListbox: Listbox.Model,
): Model => {
  if (
    Array.some(model.snoozeListboxes, entry => entry.dispatchId === dispatchId)
  ) {
    return modifyFields(model, {
      snoozeListboxes: () =>
        Array.map(model.snoozeListboxes, entry =>
          entry.dispatchId === dispatchId
            ? modifyFields(entry, { listbox: () => nextListbox })
            : entry,
        ),
    })
  }

  return modifyFields(model, {
    snoozeListboxes: () => [
      ...model.snoozeListboxes,
      SnoozeListboxEntry.make({ dispatchId, listbox: nextListbox }),
    ],
  })
}

const snoozeListboxOutMessage = listboxOutMessageFold<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>({
  handleUpdate: (model, message) => update(model, message),
  toMessage: (_model, value) =>
    Message.ChangedSnoozeMinutes({ minutes: Number(value) }),
})

const startRead = (model: Model, shouldDrain: boolean): UpdateReturn => {
  const generation = model.fetchGeneration + 1
  const history = model.isHistory

  const next = modifyFields(model, {
    fetchGeneration: () => generation,
    isLoading: () => true,
  })

  return {
    model: next,
    commands: [
      shouldDrain
        ? DrainQueueAndFetchInbox({ generation, history })
        : FetchInbox({ generation, history }),
    ],
  }
}

const withItems = (
  model: Model,
  generation: number,
  items: ReadonlyArray<ReminderInboxItem>,
): UpdateReturn => {
  if (generation !== model.fetchGeneration) {
    return { model }
  }

  return {
    model: modifyFields(model, {
      items: () => items,
      isLoading: () => false,
      maybeError: () => Option.none(),
      snoozeListboxes: () =>
        Array.filter(model.snoozeListboxes, entry =>
          Array.some(items, item => item.dispatch.id === entry.dispatchId),
        ),
    }),
  }
}

const withFailure = (
  model: Model,
  generation: number,
  failure: ReminderFailure,
): UpdateReturn => {
  if (generation !== model.fetchGeneration) {
    return { model }
  }

  return {
    model: modifyFields(model, {
      isLoading: () => false,
      maybeError: () => Option.some(reminderFailureCopy(failure)),
    }),
  }
}

export const update = (model: Model, message: Message): UpdateReturn => {
  const foldSnoozeListbox = Update.foldChildAt({
    update: SnoozeListbox.update,
    readAt: (listModel: Model, dispatchId: string) =>
      Option.some(snoozeListboxFor(listModel, dispatchId)),
    writeAt: writeSnoozeListbox,
    toParentMessage: (dispatchId, message) =>
      Message.GotSnoozeListboxMessage({ dispatchId, message }),
    foldOutMessage: () => snoozeListboxOutMessage,
  })

  return Message.match<UpdateReturn>(message, {
    ChangedVisibility: ({ isVisible }) =>
      isVisible ? startRead(model, true) : { model },

    ReceivedReminderAction: () => startRead(model, true),

    ClickedToggleHistory: () =>
      startRead(
        modifyFields(model, { isHistory: () => !model.isHistory }),
        false,
      ),

    ChangedSnoozeMinutes: ({ minutes }) =>
      isSnoozePreset(minutes)
        ? {
            model: modifyFields(model, { snoozeMinutes: () => minutes }),
          }
        : { model },

    GotSnoozeListboxMessage: ({ dispatchId, message }) =>
      foldSnoozeListbox(model, dispatchId, message),

    ClickedToggleReminderVisibility: ({ reminderId, visibility }) => ({
      model: modifyFields(model, { maybeError: () => Option.none() }),
      commands: [SetReminderVisibility({ reminderId, visibility })],
    }),

    CompletedSetReminderVisibility: ({ reminderId, visibility }) => ({
      model: modifyFields(model, {
        items: () =>
          Array.map(model.items, item =>
            item.reminderId === reminderId ? { ...item, visibility } : item,
          ),
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetReminderVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybeError: () => Option.some(message),
      }),
    }),

    ClickedRespond: ({ dispatchId, response }) => {
      if (Option.isSome(model.maybeBusyDispatchId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeBusyDispatchId: () => Option.some(dispatchId),
        }),
        commands: [
          RespondToReminder({
            dispatchId,
            response,
            maybeSnoozeMinutes:
              response === 'snooze'
                ? Option.some(model.snoozeMinutes)
                : Option.none(),
          }),
        ],
      }
    },

    CompletedFetchInbox: ({ generation, items }) =>
      withItems(model, generation, items),

    FailedFetchInbox: ({ generation, failure }) =>
      withFailure(model, generation, failure),

    CompletedDrainQueueAndFetchInbox: ({ generation, items }) =>
      withItems(model, generation, items),

    FailedDrainQueueAndFetchInbox: ({ generation, failure }) =>
      withFailure(model, generation, failure),

    CompletedRespondToReminder: ({ dispatchId }) => {
      const answered = modifyFields(model, {
        maybeBusyDispatchId: () => Option.none(),
        maybeError: () => Option.none(),
        items: () =>
          Array.filter(model.items, item => item.dispatch.id !== dispatchId),
      })

      return startRead(answered, false)
    },

    FailedRespondToReminder: ({ failure }) => ({
      model: modifyFields(model, {
        maybeBusyDispatchId: () => Option.none(),
        maybeError: () => Option.some(reminderFailureCopy(failure)),
      }),
    }),
  })
}

/**
 * Entry capability the root folds instead of constructing a child Message. A
 * fresh mount resets the transient inbox state, exactly like the legacy
 * component remount, while keeping the read generation monotonic.
 */
export const entered = (model: Model): UpdateReturn =>
  startRead(
    modifyFields(initialModel(), {
      fetchGeneration: () => model.fetchGeneration,
    }),
    true,
  )

// SUBSCRIPTION

const serviceWorkerEvents: Stream.Stream<Message> = eventStream(emit => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }

  const onMessage = (event: MessageEvent) => {
    const decoded = Schema.decodeUnknownOption(ReminderActionMessage)(
      event.data,
    )

    if (Option.isSome(decoded)) {
      emit(Message.ReceivedReminderAction())
    }
  }

  navigator.serviceWorker.addEventListener('message', onMessage)

  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage)
  }
})

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  remindersVisibility: Subscription.persistentEntry(
    visibilityEvents(isVisible => Message.ChangedVisibility({ isVisible })),
  ),
  remindersServiceWorker: Subscription.persistentEntry(serviceWorkerEvents),
}))

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) =>
  remindersPageView(model, h),
)
