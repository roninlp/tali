import { Array, Effect, Option, Schema, Struct } from 'effect'
import { Command, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  Capture,
  CaptureCommitResult,
  CaptureDraft,
  CaptureId,
  uuidV7,
} from '@tali/domain'

import {
  CaptureFailure,
  commitCapture,
  dissectCapture,
  listCaptures,
} from '../lib/capture-api'
import { loadCaptureText, saveCaptureText } from '../lib/capture-draft-cache'
import type { DisplayFields } from '../preferences-model'
import { captureView } from './capture-view'

/**
 * The `/capture` Submodel (ticket #101; ADR-0012).
 *
 * One free-text box, one Dissect, a flat set of review cards, one Commit. The
 * model keeps the composer text (and mirrors it to localStorage through a
 * Command), the cards, and the last result. The screen is deliberately not
 * offline-first: Capture needs the model, so the page says so and offers a
 * retry instead of pretending a write is queued.
 *
 * Needs Input is a typed field on a card, never a second model call. The card
 * renders the real picker and writes the draft field; the commit stays blocked
 * while any visible card still has an unanswered entry.
 */

// MODEL

export const Phase = Schema.Literals([
  'idle',
  'dissecting',
  'review',
  'committing',
  'result',
])
export type Phase = typeof Phase.Type

export const CaptureCard = Schema.Struct({
  /** Stable list key; drafts themselves have no id until they become rows. */
  cardId: Schema.String,
  draft: CaptureDraft,
  /** The editable title; the draft keeps the structural fields. */
  title: Schema.String,
  isDiscarded: Schema.Boolean,
})
export type CaptureCard = typeof CaptureCard.Type

export const Model = Schema.Struct({
  text: Schema.String,
  phase: Phase,
  cards: Schema.Array(CaptureCard),
  maybeCaptureId: Schema.Option(Schema.String),
  maybeCapture: Schema.Option(Capture),
  maybeResult: Schema.Option(CaptureCommitResult),
  maybeError: Schema.Option(Schema.String),
  maybeRetryAfter: Schema.Option(Schema.Int),
  history: Schema.Array(Capture),
  isHistoryLoading: Schema.Boolean,
  maybeHistoryError: Schema.Option(Schema.String),
  expandedHistoryId: Schema.Option(Schema.String),
  historyGeneration: Schema.Int,
  dissectGeneration: Schema.Int,
  commitGeneration: Schema.Int,
})
export type Model = typeof Model.Type

export type Inputs = Readonly<{
  display: DisplayFields
  isOnline: boolean
  maybeUserId: Option.Option<string>
}>

export type ViewInputs = Inputs

export const initialModel = (options: {
  readonly maybeUserId: Option.Option<string>
}): Model =>
  Model.make({
    text: Option.match(options.maybeUserId, {
      onNone: () => loadCaptureText(undefined),
      onSome: (userId) => loadCaptureText(userId),
    }),
    phase: 'idle',
    cards: [],
    maybeCaptureId: Option.none(),
    maybeCapture: Option.none(),
    maybeResult: Option.none(),
    maybeError: Option.none(),
    maybeRetryAfter: Option.none(),
    history: [],
    isHistoryLoading: false,
    maybeHistoryError: Option.none(),
    expandedHistoryId: Option.none(),
    historyGeneration: 0,
    dissectGeneration: 0,
    commitGeneration: 0,
  })

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedText: { value: Schema.String },
  ClickedDissect: {},
  ClickedRetryDissect: {},
  CompletedDissect: { capture: Capture },
  FailedDissect: { failure: CaptureFailure },
  ClickedCommit: {},
  ClickedRetryCommit: {},
  CompletedCommit: { result: CaptureCommitResult },
  FailedCommit: { failure: CaptureFailure },
  ClickedDiscardCard: { index: Schema.Int },
  UpdatedCardTitle: { index: Schema.Int, value: Schema.String },
  UpdatedCardField: {
    index: Schema.Int,
    field: Schema.String,
    value: Schema.String,
  },
  AnsweredNeedsInput: {
    index: Schema.Int,
    field: Schema.String,
    value: Schema.String,
  },
  SelectedHabitFrequency: {
    index: Schema.Int,
    kind: Schema.Literals(['daily', 'weekdays', 'weekly']),
  },
  SelectedReminderRepeat: {
    index: Schema.Int,
    kind: Schema.Literals(['once', 'daily', 'weekly', 'interval']),
  },
  ToggledWeekday: {
    index: Schema.Int,
    kind: Schema.Literals(['habit', 'reminder']),
    day: Schema.Int,
  },
  ChangedNumberField: {
    index: Schema.Int,
    field: Schema.String,
    value: Schema.Int,
  },
  ClickedNewCapture: {},
  CompletedLoadHistory: {
    generation: Schema.Int,
    captures: Schema.Array(Capture),
  },
  FailedLoadHistory: { generation: Schema.Int, failure: CaptureFailure },
  ClickedToggleHistory: { captureId: Schema.String },
  CompletedCacheText: {},
})
export type Message = typeof Message.Type

// COMMAND

export const DissectCapture = Command.define('DissectCapture', {
  args: { generation: Schema.Int, text: Schema.String },
  messages: [Message.CompletedDissect, Message.FailedDissect],
  execute: ({ text }) =>
    dissectCapture({ text }).pipe(
      Effect.map((result) =>
        result.ok
          ? Message.CompletedDissect({ capture: result.value })
          : Message.FailedDissect({ failure: result.error }),
      ),
    ),
})

export const CommitCapture = Command.define('CommitCapture', {
  args: {
    generation: Schema.Int,
    captureId: Schema.String,
    drafts: Schema.Array(CaptureDraft),
  },
  messages: [Message.CompletedCommit, Message.FailedCommit],
  execute: ({ captureId, drafts }) =>
    commitCapture({ captureId: CaptureId.make(captureId), drafts }).pipe(
      Effect.map((result) =>
        result.ok
          ? Message.CompletedCommit({ result: result.value })
          : Message.FailedCommit({ failure: result.error }),
      ),
    ),
})

export const LoadHistory = Command.define('LoadHistory', {
  args: { generation: Schema.Int },
  messages: [Message.CompletedLoadHistory, Message.FailedLoadHistory],
  execute: ({ generation }) =>
    listCaptures({ limit: 20 }).pipe(
      Effect.map((result) =>
        result.ok
          ? Message.CompletedLoadHistory({ generation, captures: result.value })
          : Message.FailedLoadHistory({ generation, failure: result.error }),
      ),
    ),
})

export const CacheText = Command.define('CacheText', {
  args: { userId: Schema.String, text: Schema.String },
  messages: [Message.CompletedCacheText],
  execute: ({ userId, text }) =>
    Effect.sync(() => {
      saveCaptureText(userId, text)
      return Message.CompletedCacheText()
    }),
})

// INIT / ENTER

export const init = (options: {
  readonly maybeUserId: Option.Option<string>
}): Update.Return<Model, Message> => ({
  model: initialModel(options),
})

/** Load the history when the route enters; the composer text is already cached. */
export const entered = (model: Model): Update.Return<Model, Message> => {
  const generation = model.historyGeneration + 1
  return {
    model: modifyFields(model, {
      historyGeneration: () => generation,
      isHistoryLoading: () => true,
    }),
    commands: [LoadHistory({ generation })],
  }
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const cacheCommands = (
  model: Model,
  inputs: Inputs,
): ReadonlyArray<Command.Command<Message>> =>
  Option.match(inputs.maybeUserId, {
    onNone: () => [],
    onSome: (userId) => [CacheText({ userId, text: model.text })],
  })

const withError = (model: Model, message: string): Model =>
  modifyFields(model, {
    maybeError: () => Option.some(message),
    maybeRetryAfter: () => Option.none(),
  })

const updateCard = (
  model: Model,
  index: number,
  update: (card: CaptureCard) => CaptureCard,
): Model =>
  modifyFields(model, {
    cards: () =>
      model.cards.map((card, cardIndex) =>
        cardIndex === index ? update(card) : card,
      ),
  })

export const visibleCards = (model: Model): ReadonlyArray<CaptureCard> =>
  model.cards.filter((card) => !card.isDiscarded)

const cardToDraft = (card: CaptureCard): CaptureDraft => {
  const title = card.title.trim()
  return Struct.assign(card.draft, { title: title === '' ? undefined : title })
}

const missingFieldOf = (field: string): string => {
  if (field.startsWith('timing.')) return 'timing'
  if (field.startsWith('repeat.')) return 'repeat'
  return field
}

const withoutMissing = (draft: CaptureDraft, field: string): CaptureDraft =>
  modifyFields(draft, {
    missing: () =>
      draft.missing.filter((entry) => entry.field !== missingFieldOf(field)),
  })

const setDraftField = (
  draft: CaptureDraft,
  field: string,
  value: string,
): CaptureDraft => {
  if (draft._tag === 'task') {
    if (field === 'dueDate') {
      return Struct.assign(draft, {
        dueDate: value === '' ? undefined : value,
        dueAt: undefined,
      })
    }
    if (field === 'dueAt') {
      return Struct.assign(draft, {
        dueAt: value === '' ? undefined : value,
        dueDate: undefined,
      })
    }
    return draft
  }

  if (draft._tag === 'event') {
    if (field === 'timing' || field === 'timing.date') {
      return Struct.assign(draft, {
        timing: value === '' ? undefined : { _tag: 'allDay' as const, date: value },
      })
    }
    if (field === 'timing.start') {
      if (value === '') return draft
      const current = draft.timing
      const end =
        current?._tag === 'timed'
          ? current.end
          : new Date(Date.parse(value) + 60 * 60 * 1000).toISOString()
      return Struct.assign(draft, {
        timing: { _tag: 'timed' as const, start: value, end },
      })
    }
    if (field === 'timing.end') {
      if (value === '') return draft
      const current = draft.timing
      const start = current?._tag === 'timed' ? current.start : value
      return Struct.assign(draft, {
        timing: { _tag: 'timed' as const, start, end: value },
      })
    }
    return draft
  }

  if (draft._tag === 'habit') {
    if (field === 'reminderTime') {
      return Struct.assign(draft, {
        reminderTime: value === '' ? undefined : value,
      })
    }
    return draft
  }

  if (draft._tag === 'reminder') {
    if (field === 'fireAt') {
      return Struct.assign(draft, {
        fireAt: value === '' ? undefined : value,
      })
    }
    if (field === 'repeat.time') {
      const repeat = draft.repeat
      if (repeat === undefined) return draft
      if (repeat._tag === 'daily' || repeat._tag === 'weekly') {
        return Struct.assign(draft, {
          repeat: modifyFields(repeat, { time: () => value }),
        })
      }
      return draft
    }
    return draft
  }

  return draft
}

const answerNeedsInput = (
  draft: CaptureDraft,
  field: string,
  value: string,
): CaptureDraft => {
  if (field === 'timing' || field === 'timing.date') {
    return withoutMissing(setDraftField(draft, 'timing.date', value), field)
  }
  return withoutMissing(setDraftField(draft, field, value), field)
}

const toggleWeekday = (
  days: ReadonlyArray<number>,
  day: number,
): ReadonlyArray<number> =>
  days.includes(day)
    ? days.length === 1
      ? days
      : days.filter((candidate) => candidate !== day)
    : [...days, day].sort((left, right) => left - right)

const setHabitFrequency = (
  draft: CaptureDraft,
  kind: 'daily' | 'weekdays' | 'weekly',
): CaptureDraft => {
  if (draft._tag !== 'habit') return draft
  const current = draft.frequency
  const frequency =
    kind === 'daily'
      ? { _tag: 'daily' as const }
      : kind === 'weekdays'
        ? current?._tag === 'weekdays'
          ? current
          : { _tag: 'weekdays' as const, days: [6] }
        : current?._tag === 'weekly'
          ? current
          : { _tag: 'weekly' as const, times: 3 }
  return withoutMissing(
    Struct.assign(draft, { frequency }),
    'frequency',
  )
}

const setReminderRepeat = (
  draft: CaptureDraft,
  kind: 'once' | 'daily' | 'weekly' | 'interval',
): CaptureDraft => {
  if (draft._tag !== 'reminder') return draft
  const current = draft.repeat
  const time =
    current !== undefined && (current._tag === 'daily' || current._tag === 'weekly')
      ? current.time
      : '08:00'
  const repeat =
    kind === 'once'
      ? { _tag: 'once' as const }
      : kind === 'daily'
        ? { _tag: 'daily' as const, time }
        : kind === 'weekly'
          ? {
              _tag: 'weekly' as const,
              days:
                current?._tag === 'weekly' ? current.days : [5],
              time,
            }
          : {
              _tag: 'interval' as const,
              hours: current?._tag === 'interval' ? current.hours : 8,
            }

  const withRepeat = withoutMissing(
    Struct.assign(draft, { repeat }),
    'repeat',
  )

  // A one-off reminder with no fire time is still a Needs Input.
  if (kind === 'once' && draft.fireAt === undefined) {
    return modifyFields(withRepeat, {
      missing: () =>
        withRepeat.missing.some((entry) => entry.field === 'fireAt')
          ? withRepeat.missing
          : [
              ...withRepeat.missing,
              {
                field: 'fireAt',
                shape: 'instant' as const,
                question: 'این یادآور چه زمانی باشد؟',
              },
            ],
    })
  }

  return withRepeat
}

const updateNumberField = (
  draft: CaptureDraft,
  field: string,
  value: number,
): CaptureDraft => {
  if (draft._tag === 'habit' && field === 'times') {
    const current = draft.frequency
    if (current?._tag !== 'weekly') return draft
    return modifyFields(draft, {
      frequency: () => ({ _tag: 'weekly', times: value }),
    })
  }
  if (draft._tag === 'reminder' && field === 'hours') {
    const current = draft.repeat
    if (current?._tag !== 'interval') return draft
    return modifyFields(draft, {
      repeat: () => ({ _tag: 'interval', hours: value }),
    })
  }
  return draft
}

const startDissect = (model: Model, inputs: Inputs): UpdateReturn => {
  if (!inputs.isOnline) {
    return {
      model: withError(
        model,
        'کپچر به اینترنت نیاز دارد. متن تو همین‌جا می‌ماند؛ آنلاین شو و دوباره تلاش کن.',
      ),
    }
  }
  if (model.text.trim() === '') {
    return { model: withError(model, 'اول چیزی بنویس.') }
  }
  const generation = model.dissectGeneration + 1
  return {
    model: modifyFields(model, {
      phase: () => 'dissecting',
      maybeError: () => Option.none(),
      maybeRetryAfter: () => Option.none(),
      maybeResult: () => Option.none(),
      dissectGeneration: () => generation,
    }),
    commands: [DissectCapture({ generation, text: model.text })],
  }
}

const startCommit = (model: Model): UpdateReturn => {
  const cards = visibleCards(model)
  if (cards.length === 0) {
    return { model: withError(model, 'کارتی برای ساخت نیست.') }
  }
  const blocked = cards.findIndex((card) => card.draft.missing.length > 0)
  if (blocked >= 0) {
    return {
      model: withError(
        model,
        'تا وقتی Needs Input یک کارت پاسخ داده نشده، ساخت انجام نمی‌شود.',
      ),
    }
  }
  const maybeCaptureId = model.maybeCaptureId
  if (Option.isNone(maybeCaptureId)) {
    return { model: withError(model, 'کپچر پیدا نشد؛ دوباره تجزیه کن.') }
  }
  const generation = model.commitGeneration + 1
  return {
    model: modifyFields(model, {
      phase: () => 'committing',
      maybeError: () => Option.none(),
      maybeRetryAfter: () => Option.none(),
      commitGeneration: () => generation,
    }),
    commands: [
      CommitCapture({
        generation,
        captureId: maybeCaptureId.value,
        drafts: cards.map(cardToDraft),
      }),
    ],
  }
}

const historyCommand = (model: Model): ReadonlyArray<Command.Command<Message>> => {
  const generation = model.historyGeneration + 1
  return [LoadHistory({ generation })]
}

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedText: ({ value }) => {
      const next = modifyFields(model, {
        text: () => value,
        maybeError: () => Option.none(),
      })
      return { model: next, commands: cacheCommands(next, inputs) }
    },

    ClickedDissect: () => startDissect(model, inputs),
    ClickedRetryDissect: () => startDissect(model, inputs),

    CompletedDissect: ({ capture }) => {
      if (capture.status === 'failed') {
        return {
          model: modifyFields(model, {
            phase: () => 'idle',
            maybeCapture: () => Option.some(capture),
            maybeError: () =>
              Option.some(
                capture.error ??
                  'مدل پاسخ نداد. متن تو حفظ شده است؛ دوباره تلاش کن.',
              ),
          }),
        }
      }
      const cards = Array.map(capture.drafts, (draft) =>
        CaptureCard.make({
          cardId: uuidV7(),
          draft,
          title: draft.title ?? '',
          isDiscarded: false,
        }),
      )
      return {
        model: modifyFields(model, {
          phase: () => 'review',
          cards: () => cards,
          maybeCaptureId: () => Option.some(capture.id),
          maybeCapture: () => Option.some(capture),
          maybeError: () => Option.none(),
          maybeRetryAfter: () => Option.none(),
        }),
        commands: historyCommand(model),
      }
    },

    FailedDissect: ({ failure }) => ({
      model: modifyFields(model, {
        phase: () => 'idle',
        maybeError: () => Option.some(failure.message),
        maybeRetryAfter: () =>
          failure.retryAfterSeconds === undefined
            ? Option.none()
            : Option.some(failure.retryAfterSeconds),
      }),
    }),

    ClickedCommit: () => startCommit(model),
    ClickedRetryCommit: () => startCommit(model),

    CompletedCommit: ({ result }) => {
      const isComplete = result.failure === null
      const next = modifyFields(model, {
        phase: () => 'result',
        maybeResult: () => Option.some(result),
        maybeCapture: () => Option.some(result.capture),
        maybeError: () =>
          result.failure === null
            ? Option.none()
            : Option.some(
                'بخشی از کارت‌ها ساخته شد. دوباره تلاش کن؛ بقیه بدون تکرار ساخته می‌شوند.',
              ),
        ...(isComplete
          ? {
              text: () => '',
              maybeCaptureId: () => Option.none(),
            }
          : {}),
      })
      return {
        model: next,
        commands: [
          ...(isComplete ? cacheCommands(next, inputs) : []),
          ...historyCommand(next),
        ],
      }
    },

    FailedCommit: ({ failure }) => ({
      model: modifyFields(model, {
        phase: () => 'review',
        maybeError: () => Option.some(failure.message),
      }),
    }),

    ClickedDiscardCard: ({ index }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, { isDiscarded: () => true }),
      ),
    }),

    UpdatedCardTitle: ({ index, value }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, { title: () => value }),
      ),
    }),

    UpdatedCardField: ({ index, field, value }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, {
          draft: () => setDraftField(card.draft, field, value),
        }),
      ),
    }),

    AnsweredNeedsInput: ({ index, field, value }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, {
          draft: () =>
            answerNeedsInput(card.draft, field, value),
        }),
      ),
    }),

    SelectedHabitFrequency: ({ index, kind }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, {
          draft: () => setHabitFrequency(card.draft, kind),
        }),
      ),
    }),

    SelectedReminderRepeat: ({ index, kind }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, {
          draft: () => setReminderRepeat(card.draft, kind),
        }),
      ),
    }),

    ToggledWeekday: ({ index, kind, day }) => ({
      model: updateCard(model, index, (card) => {
        if (kind === 'habit' && card.draft._tag === 'habit') {
          const draft = card.draft
          const current = draft.frequency
          if (current?._tag !== 'weekdays') return card
          return modifyFields(card, {
            draft: () =>
              modifyFields(draft, {
                frequency: () => ({
                  _tag: 'weekdays',
                  days: toggleWeekday(current.days, day),
                }),
              }),
          })
        }
        if (kind === 'reminder' && card.draft._tag === 'reminder') {
          const draft = card.draft
          const current = draft.repeat
          if (current?._tag !== 'weekly') return card
          return modifyFields(card, {
            draft: () =>
              modifyFields(draft, {
                repeat: () => ({
                  _tag: 'weekly',
                  time: current.time,
                  days: toggleWeekday(current.days, day),
                }),
              }),
          })
        }
        return card
      }),
    }),

    ChangedNumberField: ({ index, field, value }) => ({
      model: updateCard(model, index, (card) =>
        modifyFields(card, {
          draft: () => updateNumberField(card.draft, field, value),
        }),
      ),
    }),

    ClickedNewCapture: () => {
      const next = modifyFields(model, {
        text: () => '',
        phase: () => 'idle',
        cards: () => [],
        maybeCaptureId: () => Option.none(),
        maybeCapture: () => Option.none(),
        maybeResult: () => Option.none(),
        maybeError: () => Option.none(),
        maybeRetryAfter: () => Option.none(),
      })
      return { model: next, commands: cacheCommands(next, inputs) }
    },

    CompletedLoadHistory: ({ captures }) => ({
      model: modifyFields(model, {
        history: () => captures,
        isHistoryLoading: () => false,
        maybeHistoryError: () => Option.none(),
      }),
    }),

    FailedLoadHistory: ({ failure }) => ({
      model: modifyFields(model, {
        isHistoryLoading: () => false,
        maybeHistoryError: () => Option.some(failure.message),
      }),
    }),

    ClickedToggleHistory: ({ captureId }) => ({
      model: modifyFields(model, {
        expandedHistoryId: () =>
          Option.contains(model.expandedHistoryId, captureId)
            ? Option.none()
            : Option.some(captureId),
      }),
    }),

    CompletedCacheText: () => ({ model }),
  })

// VIEW

export const view = captureView
