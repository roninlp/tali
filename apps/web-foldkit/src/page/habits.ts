import { Array, Clock, Duration, Effect, Option, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Dialog } from '@foldkit/ui'
import type { HabitEntryStatus } from '@tali/domain'
import { uuidV7 } from '@tali/domain'
import { HABIT_RESTORE_REFUSED } from '@tali/sync-client'

import {
  DEFAULT_HABIT_COLOR,
  DEFAULT_HABIT_ICON,
  DEFAULT_HABIT_TIMES,
  DEFAULT_HABIT_WEEKDAYS,
  HABIT_COLORS,
  HABIT_WINDOW_DAYS,
  HabitFrequency,
  HabitFrequencyMode,
  HabitRow,
  HabitWindowDays,
  clampHabitTimes,
  habitFrequencyDraft,
  habitIconChoices,
  habitMonthOf,
  habitStatusLabel,
  habitTimeZone,
  habitToday,
  shiftHabitMonth,
  toggleHabitWeekday,
} from '../habits-model'
import { habitEntryStatusOf, tapHabitEntry } from '../lib/habit-log'
import {
  createHabitInMirror,
  deleteHabitInMirror,
  restoreHabitInMirror,
  updateHabitInMirror,
} from '../lib/habit-writes'
import { setVisibilityInMirror } from '../lib/visibility-writes'
import type { MirrorSnapshot } from '../mirror'
import type { DisplayFields } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import type { ConfirmSpec } from '../ui/confirm'
import * as Picker from '../ui/picker'
import { Toast, ToastUndo } from '../ui/toast'
import { habitsPageView } from './habits-view'

/**
 * The `/habits` screen Submodel, ported from
 * `apps/web/src/components/habits/habits-screen.tsx` (ticket #66;
 * FR-HAB-01/02/03).
 *
 * One form creates and edits: title, description, frequency (daily / selected
 * weekdays / N times a week), reminder time, icon and colour. The list and the
 * monthly heatmap read the mirror snapshot that arrives as inputs, while the
 * Model keeps the form draft, the busy flags, the open heatmap month and the
 * delete toast. Every write goes through the local store first, then the root
 * asks sync to re-read the mirror; no habit write uses RPC.
 */

// MODEL

export const HeatMonth = Schema.Struct({
  year: Schema.Int,
  month: Schema.Int,
})

export type HeatMonth = typeof HeatMonth.Type

export const HeatState = Schema.Struct({
  habitId: Schema.String,
  month: HeatMonth,
})

export type HeatState = typeof HeatState.Type

export const PendingHabitDelete = Schema.Struct({
  habitId: Schema.String,
  title: Schema.String,
})

export type PendingHabitDelete = typeof PendingHabitDelete.Type

export const Model = Schema.Struct({
  now: Schema.Number,
  windowDays: HabitWindowDays,
  maybeEditingId: Schema.Option(Schema.String),
  title: Schema.String,
  description: Schema.String,
  reminderTime: Schema.String,
  frequencyMode: HabitFrequencyMode,
  weekdays: Schema.Array(Schema.Int),
  timesPerWeek: Schema.Int,
  icon: Schema.String,
  color: Schema.String,
  isSaving: Schema.Boolean,
  maybeFormError: Schema.Option(Schema.String),
  maybePageError: Schema.Option(Schema.String),
  announcement: Schema.String,
  maybeBusyId: Schema.Option(Schema.String),
  maybeHeat: Schema.Option(HeatState),
  maybePendingDelete: Schema.Option(PendingHabitDelete),
  confirmDialog: Dialog.Model,
  toast: Toast.Model,
  picker: Picker.Model,
})

export type Model = typeof Model.Type

export const initialModel = (now: number): Model =>
  Model.make({
    now,
    windowDays: 30,
    maybeEditingId: Option.none(),
    title: '',
    description: '',
    reminderTime: '',
    frequencyMode: 'daily',
    weekdays: DEFAULT_HABIT_WEEKDAYS,
    timesPerWeek: DEFAULT_HABIT_TIMES,
    icon: DEFAULT_HABIT_ICON,
    color: DEFAULT_HABIT_COLOR,
    isSaving: false,
    maybeFormError: Option.none(),
    maybePageError: Option.none(),
    announcement: '',
    maybeBusyId: Option.none(),
    maybeHeat: Option.none(),
    maybePendingDelete: Option.none(),
    confirmDialog: Dialog.init({ id: 'habits-delete-dialog' }),
    toast: Toast.init({ id: 'habits-toast' }),
    picker: Picker.init({ id: 'habits-picker' }),
  })

/** Everything the screen reads from its siblings on each dispatch. */
export type Inputs = Readonly<{
  display: DisplayFields
  isStoreReady: boolean
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
  maybeSyncError: Option.Option<string>
  maybeUserId: Option.Option<string>
}>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  TickedClock: { now: Schema.Number },
  UpdatedHabitTitle: { value: Schema.String },
  UpdatedHabitDescription: { value: Schema.String },
  UpdatedHabitReminderTime: { value: Schema.String },
  ClickedClearReminder: {},
  SelectedFrequencyMode: { mode: HabitFrequencyMode },
  ToggledWeekday: { day: Schema.Int },
  PressedIncreaseTimes: {},
  PressedDecreaseTimes: {},
  SelectedHabitIcon: { icon: Schema.String },
  SelectedHabitColor: { color: Schema.String },
  SubmittedHabitForm: {},
  CompletedCreateHabit: { habitId: Schema.String, title: Schema.String },
  FailedCreateHabit: { message: Schema.String },
  ClickedEditHabit: { habitId: Schema.String },
  CompletedFocusHabitTitle: {},
  ClickedCancelEdit: {},
  CompletedUpdateHabit: { habitId: Schema.String, title: Schema.String },
  FailedUpdateHabit: { message: Schema.String },
  ClickedToggleHabitVisibility: { habitId: Schema.String },
  CompletedSetHabitVisibility: {
    habitId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  FailedSetHabitVisibility: { message: Schema.String },
  ClickedDeleteHabit: { habitId: Schema.String, title: Schema.String },
  ConfirmedDeleteHabit: {},
  GotConfirmDialogMessage: { message: Dialog.Message },
  CompletedDeleteHabit: { habitId: Schema.String, title: Schema.String },
  FailedDeleteHabit: { message: Schema.String },
  ClickedUndoDelete: { entryId: Schema.String, undo: ToastUndo },
  CompletedRestoreHabit: { habitId: Schema.String, title: Schema.String },
  FailedRestoreHabit: { message: Schema.String },
  ClickedTapHabit: { habitId: Schema.String, title: Schema.String },
  CompletedTapHabit: {
    habitId: Schema.String,
    title: Schema.String,
    status: Schema.Literals(['done', 'partial', 'missed']),
  },
  FailedTapHabit: { message: Schema.String },
  SelectedHabitWindow: { window: HabitWindowDays },
  ClickedToggleHeat: { habitId: Schema.String },
  PressedPreviousHeatMonth: {},
  PressedNextHeatMonth: {},
  ClickedCurrentHeatMonth: {},
  GotToastMessage: { message: Toast.Message },
  GotPickerMessage: { message: Picker.Message },
})

export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
})

export type OutMessage = typeof OutMessage.Type

// COMMAND

const storeFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره در حافظه‌ی محلی ناموفق بود'

const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

export const FocusHabitTitle = Command.define('FocusHabitTitle', {
  messages: [Message.CompletedFocusHabitTitle],
  execute: Dom.focus('#habit-title', { preventScroll: true }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusHabitTitle()),
  ),
})

export const CreateHabit = Command.define('CreateHabit', {
  args: {
    title: Schema.String,
    description: Schema.Option(Schema.String),
    reminderTime: Schema.Option(Schema.String),
    frequency: HabitFrequency,
    icon: Schema.String,
    color: Schema.String,
    timeZone: Schema.String,
  },
  messages: [Message.CompletedCreateHabit, Message.FailedCreateHabit],
  execute: ({
    title,
    description,
    reminderTime,
    frequency,
    icon,
    color,
    timeZone,
  }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const habitId = uuidV7(now)
      const instant = new Date(now).toISOString()

      yield* Effect.tryPromise({
        try: () =>
          createHabitInMirror(
            store,
            {
              title,
              description: Option.getOrNull(description),
              reminderTime: Option.getOrNull(reminderTime),
              frequency,
              icon,
              color,
              timeZone: habitTimeZone(timeZone),
            },
            habitId,
            instant,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateHabit({ habitId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateHabit({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const UpdateHabit = Command.define('UpdateHabit', {
  args: {
    habit: HabitRow,
    title: Schema.String,
    description: Schema.Option(Schema.String),
    reminderTime: Schema.Option(Schema.String),
    frequency: HabitFrequency,
    icon: Schema.String,
    color: Schema.String,
  },
  messages: [Message.CompletedUpdateHabit, Message.FailedUpdateHabit],
  execute: ({
    habit,
    title,
    description,
    reminderTime,
    frequency,
    icon,
    color,
  }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          updateHabitInMirror(
            store,
            habit,
            {
              title,
              description: Option.getOrNull(description),
              reminderTime: Option.getOrNull(reminderTime),
              frequency,
              icon,
              color,
            },
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedUpdateHabit({ habitId: habit.id, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUpdateHabit({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const DeleteHabit = Command.define('DeleteHabit', {
  args: { habitId: Schema.String, title: Schema.String },
  messages: [Message.CompletedDeleteHabit, Message.FailedDeleteHabit],
  execute: ({ habitId, title }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => deleteHabitInMirror(store, habitId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedDeleteHabit({ habitId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedDeleteHabit({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const SetHabitVisibility = Command.define('SetHabitVisibility', {
  args: {
    habitId: Schema.String,
    visibility: Schema.Literals(['private', 'shared']),
  },
  messages: [
    Message.CompletedSetHabitVisibility,
    Message.FailedSetHabitVisibility,
  ],
  execute: ({ habitId, visibility }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          setVisibilityInMirror(store, 'habit', habitId, visibility, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetHabitVisibility({ habitId, visibility })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetHabitVisibility({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const RestoreHabit = Command.define('RestoreHabit', {
  args: { habitId: Schema.String, title: Schema.String },
  messages: [Message.CompletedRestoreHabit, Message.FailedRestoreHabit],
  execute: ({ habitId, title }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => restoreHabitInMirror(store, habitId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedRestoreHabit({ habitId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRestoreHabit({ message: storeFailureMessage(error) }),
        ),
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
            timeZone: habitTimeZone(timeZone),
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

const findHabit = (inputs: Inputs, habitId: string): Option.Option<HabitRow> =>
  Array.findFirst(inputs.mirror.habits, habit => habit.id === habitId)

const resetForm = (model: Model): Model =>
  modifyFields(model, {
    maybeEditingId: () => Option.none(),
    title: () => '',
    description: () => '',
    reminderTime: () => '',
    frequencyMode: () => 'daily',
    weekdays: () => DEFAULT_HABIT_WEEKDAYS,
    timesPerWeek: () => DEFAULT_HABIT_TIMES,
    icon: () => DEFAULT_HABIT_ICON,
    color: () => DEFAULT_HABIT_COLOR,
    maybeFormError: () => Option.none(),
  })

const beginEdit = (model: Model, habit: HabitRow): Model =>
  modifyFields(model, {
    maybeEditingId: () => Option.some(habit.id),
    title: () => habit.title,
    description: () => habit.description ?? '',
    reminderTime: () => habit.reminderTime ?? '',
    frequencyMode: () => habit.frequency._tag,
    weekdays: () =>
      habit.frequency._tag === 'weekdays'
        ? habit.frequency.days
        : model.weekdays,
    timesPerWeek: () =>
      habit.frequency._tag === 'weekly'
        ? habit.frequency.times
        : model.timesPerWeek,
    icon: () => habit.icon ?? DEFAULT_HABIT_ICON,
    color: () => habit.color ?? DEFAULT_HABIT_COLOR,
    maybeFormError: () => Option.none(),
  })

const currentToday = (model: Model, inputs: Inputs): string =>
  habitToday(model.now, inputs.display.timeZone)

/**
 * The icon picker keeps a stored custom icon while editing, so a preset chosen
 * mid-edit can still be reverted to it (the legacy form's `icons()` did the
 * same from the saved row, not the draft).
 */
export const iconChoicesFor = (
  model: Model,
  inputs: Inputs,
): ReadonlyArray<string> => {
  const maybeStoredIcon = Option.flatMap(model.maybeEditingId, habitId =>
    Option.map(
      findHabit(inputs, habitId),
      habit => habit.icon ?? DEFAULT_HABIT_ICON,
    ),
  )

  return habitIconChoices(
    Option.match(maybeStoredIcon, {
      onNone: () => model.icon,
      onSome: icon => icon,
    }),
  )
}

const currentMonth = (model: Model, inputs: Inputs): HeatMonth =>
  habitMonthOf(currentToday(model, inputs))

const shiftHeat = (model: Model, delta: number): Model =>
  Option.match(model.maybeHeat, {
    onNone: () => model,
    onSome: heat =>
      modifyFields(model, {
        maybeHeat: () =>
          Option.some({
            habitId: heat.habitId,
            month: shiftHabitMonth(heat.month.year, heat.month.month, delta),
          }),
      }),
  })

const optionalText = (value: string): Option.Option<string> => {
  const trimmed = value.trim()

  return trimmed === '' ? Option.none() : Option.some(trimmed)
}

// DIALOG AND TOAST FOLDS

const foldConfirmDialogOutMessage = Dialog.OutMessage.match<
  Update.Step<Model, Message>
>({
  Opened: () => model => ({ model }),
  Closed: () => stepModel => ({
    model: modifyFields(stepModel, {
      maybePendingDelete: () => Option.none(),
    }),
  }),
})

const foldConfirmDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.confirmDialog),
  write: (model, nextDialog) =>
    modifyFields(model, { confirmDialog: () => nextDialog }),
  toParentMessage: message => Message.GotConfirmDialogMessage({ message }),
  foldOutMessage: foldConfirmDialogOutMessage,
})

const foldConfirmDialogOpen = Update.foldChildStep({
  update: Dialog.open,
  read: (model: Model) => Option.some(model.confirmDialog),
  write: (model, nextDialog) =>
    modifyFields(model, { confirmDialog: () => nextDialog }),
  toParentMessage: message => Message.GotConfirmDialogMessage({ message }),
  foldOutMessage: foldConfirmDialogOutMessage,
})

const foldConfirmDialogClose = Update.foldChildStep({
  update: Dialog.close,
  read: (model: Model) => Option.some(model.confirmDialog),
  write: (model, nextDialog) =>
    modifyFields(model, { confirmDialog: () => nextDialog }),
  toParentMessage: message => Message.GotConfirmDialogMessage({ message }),
  foldOutMessage: foldConfirmDialogOutMessage,
})

const shownDeletedToastStep = (
  habitId: string,
  title: string,
): Update.Step<Model, Message> =>
  Update.foldChildStep({
    update: toast =>
      Toast.show(toast, {
        payload: {
          text: `«${title}» حذف شد.`,
          maybeUndo: { kind: 'restoreHabit', id: habitId, title },
        },
        variant: 'Info',
      }),
    read: (model: Model) => Option.some(model.toast),
    write: (model, nextToast) =>
      modifyFields(model, { toast: () => nextToast }),
    toParentMessage: message => Message.GotToastMessage({ message }),
    foldOutMessage: () => stepModel => ({ model: stepModel }),
  })

const dismissedToastStep = (entryId: string): Update.Step<Model, Message> =>
  Update.foldChildStep({
    update: toast => Toast.dismiss(toast, entryId),
    read: (model: Model) => Option.some(model.toast),
    write: (model, nextToast) =>
      modifyFields(model, { toast: () => nextToast }),
    toParentMessage: message => Message.GotToastMessage({ message }),
    foldOutMessage: () => stepModel => ({ model: stepModel }),
  })

const foldToast = Update.foldChild({
  update: Toast.update,
  read: (model: Model) => Option.some(model.toast),
  write: (model, nextToast) => modifyFields(model, { toast: () => nextToast }),
  toParentMessage: message => Message.GotToastMessage({ message }),
  foldOutMessage: () => stepModel => ({ model: stepModel }),
})

const foldPickerOutMessage = Picker.OutMessage.match<
  Update.Step<Model, Message>
>({
  PickedValue:
    ({ target, value }) =>
    stepModel => ({
      model:
        target === 'habit:reminderTime'
          ? modifyFields(stepModel, { reminderTime: () => value })
          : stepModel,
    }),
  ClearedValue:
    ({ target }) =>
    stepModel => ({
      model:
        target === 'habit:reminderTime'
          ? modifyFields(stepModel, { reminderTime: () => '' })
          : stepModel,
    }),
})

const foldPicker = Update.foldChild({
  update: Picker.update,
  read: (model: Model) => Option.some(model.picker),
  write: (model, nextPicker) =>
    modifyFields(model, { picker: () => nextPicker }),
  toParentMessage: message => Message.GotPickerMessage({ message }),
  foldOutMessage: foldPickerOutMessage,
})

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotPickerMessage: ({ message: pickerMessage }) =>
      foldPicker(model, pickerMessage),

    TickedClock: ({ now }) => ({
      model: modifyFields(model, { now: () => now }),
    }),

    UpdatedHabitTitle: ({ value }) => ({
      model: modifyFields(model, { title: () => value }),
    }),

    UpdatedHabitDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value }),
    }),

    UpdatedHabitReminderTime: ({ value }) => ({
      model: modifyFields(model, { reminderTime: () => value }),
    }),

    ClickedClearReminder: () => ({
      model: modifyFields(model, { reminderTime: () => '' }),
    }),

    SelectedFrequencyMode: ({ mode }) => ({
      model: modifyFields(model, { frequencyMode: () => mode }),
    }),

    ToggledWeekday: ({ day }) => ({
      model: modifyFields(model, {
        weekdays: () => toggleHabitWeekday(model.weekdays, day),
      }),
    }),

    PressedIncreaseTimes: () => ({
      model: modifyFields(model, {
        timesPerWeek: () => clampHabitTimes(model.timesPerWeek + 1),
      }),
    }),

    PressedDecreaseTimes: () => ({
      model: modifyFields(model, {
        timesPerWeek: () => clampHabitTimes(model.timesPerWeek - 1),
      }),
    }),

    SelectedHabitIcon: ({ icon }) =>
      Array.contains(iconChoicesFor(model, inputs), icon)
        ? { model: modifyFields(model, { icon: () => icon }) }
        : { model },

    SelectedHabitColor: ({ color }) =>
      Array.some(HABIT_COLORS, entry => entry.value === color)
        ? { model: modifyFields(model, { color: () => color }) }
        : { model },

    SubmittedHabitForm: () => {
      const title = model.title.trim()

      if (!inputs.isStoreReady || model.isSaving || title === '') {
        return { model }
      }

      const draft = {
        title,
        description: optionalText(model.description),
        reminderTime: optionalText(model.reminderTime),
        frequency: habitFrequencyDraft(
          model.frequencyMode,
          model.weekdays,
          model.timesPerWeek,
        ),
        icon: model.icon,
        color: model.color,
      }

      const started = modifyFields(model, {
        isSaving: () => true,
        maybeFormError: () => Option.none(),
      })

      return Option.match(model.maybeEditingId, {
        onNone: () => ({
          model: started,
          commands: [
            CreateHabit({
              ...draft,
              timeZone: habitTimeZone(inputs.display.timeZone),
            }),
          ],
        }),
        onSome: habitId =>
          Option.match(findHabit(inputs, habitId), {
            onNone: () => ({ model }),
            onSome: habit => ({
              model: started,
              commands: [UpdateHabit({ habit, ...draft })],
            }),
          }),
      })
    },

    CompletedCreateHabit: ({ title }) => ({
      model: modifyFields(resetForm(model), {
        isSaving: () => false,
        announcement: () => `عادت تازه: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateHabit: ({ message }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        maybeFormError: () => Option.some(message),
      }),
    }),

    ClickedEditHabit: ({ habitId }) =>
      Option.match(findHabit(inputs, habitId), {
        onNone: () => ({ model }),
        onSome: habit => ({
          model: beginEdit(model, habit),
          commands: [FocusHabitTitle()],
        }),
      }),

    CompletedFocusHabitTitle: () => ({ model }),

    ClickedCancelEdit: () => ({
      model: modifyFields(resetForm(model), { isSaving: () => false }),
    }),

    CompletedUpdateHabit: ({ title }) => ({
      model: modifyFields(resetForm(model), {
        isSaving: () => false,
        announcement: () => `عادت به‌روز شد: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedUpdateHabit: ({ message }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        maybeFormError: () => Option.some(message),
      }),
    }),

    ClickedToggleHabitVisibility: ({ habitId }) =>
      Option.match(findHabit(inputs, habitId), {
        onNone: () => ({ model }),
        onSome: habit =>
          Option.contains(inputs.maybeUserId, habit.ownerId)
            ? {
                model: modifyFields(model, {
                  maybePageError: () => Option.none(),
                }),
                commands: [
                  SetHabitVisibility({
                    habitId,
                    visibility:
                      habit.visibility === 'shared' ? 'private' : 'shared',
                  }),
                ],
              }
            : { model },
      }),

    CompletedSetHabitVisibility: ({ visibility }) => ({
      model: modifyFields(model, {
        announcement: () =>
          visibility === 'shared'
            ? 'عادت با خانه به اشتراک گذاشته شد'
            : 'عادت خصوصی شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetHabitVisibility: ({ message }) => ({
      model: modifyFields(model, {
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedDeleteHabit: ({ habitId, title }) => {
      if (!inputs.isStoreReady) {
        return { model }
      }

      return Update.combine(model, [
        foldConfirmDialogOpen,
        stepModel => ({
          model: modifyFields(stepModel, {
            maybePendingDelete: () =>
              Option.some(PendingHabitDelete.make({ habitId, title })),
          }),
        }),
      ])
    },

    ConfirmedDeleteHabit: () =>
      Option.match(model.maybePendingDelete, {
        onNone: () => ({ model }),
        onSome: pending =>
          Update.combine(model, [
            foldConfirmDialogClose,
            stepModel => ({
              model: modifyFields(stepModel, {
                maybePageError: () => Option.none(),
              }),
              commands: [
                DeleteHabit({
                  habitId: pending.habitId,
                  title: pending.title,
                }),
              ],
            }),
          ]),
      }),

    CompletedDeleteHabit: ({ habitId, title }) => {
      const cleared = Option.contains(model.maybeEditingId, habitId)
        ? resetForm(model)
        : model

      return Update.withOutMessage(
        Update.combine(cleared, [
          shownDeletedToastStep(habitId, title),
          stepModel => ({
            model: modifyFields(stepModel, {
              maybeHeat: () =>
                Option.exists(model.maybeHeat, heat => heat.habitId === habitId)
                  ? Option.none()
                  : model.maybeHeat,
              announcement: () => `حذف شد: ${title}`,
            }),
          }),
        ]),
        OutMessage.WroteLocalData(),
      )
    },

    FailedDeleteHabit: ({ message }) => ({
      model: modifyFields(model, {
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedUndoDelete: ({ entryId, undo }) =>
      Update.withOutMessage(
        Update.combine(model, [
          dismissedToastStep(entryId),
          stepModel => ({
            model: modifyFields(stepModel, {
              maybePageError: () => Option.none(),
            }),
            commands: [RestoreHabit({ habitId: undo.id, title: undo.title })],
          }),
        ]),
        OutMessage.WroteLocalData(),
      ),

    CompletedRestoreHabit: ({ title }) => ({
      model: modifyFields(model, {
        announcement: () => `بازگردانی شد: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedRestoreHabit: ({ message }) => ({
      model: modifyFields(model, {
        maybePageError: () => Option.some(message),
      }),
    }),

    ClickedTapHabit: ({ habitId, title }) => {
      if (!inputs.isStoreReady || Option.isSome(model.maybeBusyId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          maybeBusyId: () => Option.some(habitId),
          maybePageError: () => Option.none(),
        }),
        commands: [
          TapHabit({
            habitId,
            title,
            localDate: currentToday(model, inputs),
            timeZone: habitTimeZone(inputs.display.timeZone),
          }),
        ],
      }
    },

    CompletedTapHabit: ({ title, status }) => ({
      model: modifyFields(model, {
        maybeBusyId: () => Option.none(),
        maybePageError: () => Option.none(),
        announcement: () => `${title}: ${habitStatusLabel(status)}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedTapHabit: ({ message }) => ({
      model: modifyFields(model, {
        maybeBusyId: () => Option.none(),
        maybePageError: () => Option.some(message),
      }),
    }),

    SelectedHabitWindow: ({ window }) =>
      Array.contains(HABIT_WINDOW_DAYS, window)
        ? { model: modifyFields(model, { windowDays: () => window }) }
        : { model },

    ClickedToggleHeat: ({ habitId }) =>
      Option.exists(model.maybeHeat, heat => heat.habitId === habitId)
        ? { model: modifyFields(model, { maybeHeat: () => Option.none() }) }
        : {
            model: modifyFields(model, {
              maybeHeat: () =>
                Option.some({
                  habitId,
                  month: currentMonth(model, inputs),
                }),
            }),
          },

    PressedPreviousHeatMonth: () => ({ model: shiftHeat(model, -1) }),

    PressedNextHeatMonth: () => ({ model: shiftHeat(model, 1) }),

    ClickedCurrentHeatMonth: () => ({
      model: Option.match(model.maybeHeat, {
        onNone: () => model,
        onSome: heat =>
          modifyFields(model, {
            maybeHeat: () =>
              Option.some({
                habitId: heat.habitId,
                month: currentMonth(model, inputs),
              }),
          }),
      }),
    }),

    GotConfirmDialogMessage: ({ message }) => foldConfirmDialog(model, message),

    GotToastMessage: ({ message }) => foldToast(model, message),
  })

// ENTRY CAPABILITY

/** The root folds this when the habits route is entered. */
export const entered = (model: Model): CommandReturn => ({
  model: modifyFields(resetForm(model), {
    windowDays: () => 30,
    isSaving: () => false,
    maybePageError: () => Option.none(),
    announcement: () => '',
    maybeBusyId: () => Option.none(),
    maybeHeat: () => Option.none(),
    maybePendingDelete: () => Option.none(),
    confirmDialog: () => Dialog.init({ id: 'habits-delete-dialog' }),
    toast: () => Toast.init({ id: 'habits-toast' }),
  }),
})

/** The legacy screen's restore-refusal notice, read from the sync error. */
export const restoreRefusalMessage = (
  maybeSyncError: Option.Option<string>,
): Option.Option<string> =>
  Option.match(maybeSyncError, {
    onNone: () => Option.none(),
    onSome: error =>
      error.startsWith(`${HABIT_RESTORE_REFUSED}:`)
        ? Option.some(
            'بازگردانی عادت انجام نشد؛ ممکن است حذف آن قطعی شده باشد.',
          )
        : Option.none(),
  })

// SPEC

/** The delete confirm copy and the accept message, from the pending state. */
export const confirmSpec = (model: Model): Option.Option<ConfirmSpec> =>
  Option.map(model.maybePendingDelete, pending => ({
    title: 'حذف عادت',
    body: `عادت «${pending.title}» حذف شود؟`,
    confirmLabel: 'حذف',
    cancelLabel: 'انصراف',
    isDanger: true,
  }))

// SUBSCRIPTION

const clockTick = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis

  return Message.TickedClock({ now })
})

/**
 * Tick once on mount so a return to the screen recomputes "today"
 * immediately, then once a minute while the route stays open.
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

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  habitsClock: Subscription.persistentEntry(clockEvents),
}))

// VIEW

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => habitsPageView(model, inputs, h),
)
