import { Effect, Result, Schema, SchemaIssue } from "effect"
import { Temporal } from "temporal-polyfill/full"
import type { RecurrenceRule } from "./recurrence.js"
import type { HabitFrequency } from "./planning/habit.js"
import type { ReminderRepeat } from "./planning/reminder.js"
import type { EventTiming } from "./planning/event.js"
import type { WeekStart } from "./common.js"
import { UserId } from "./common.js"
import { toLatinDigits } from "./digits.js"
import { normalizePersian } from "./persian.js"
import { TimestampUtc } from "./planning/common.js"
import { EventCreateInput } from "./planning/event-service.js"
import { HabitCreateInput } from "./planning/habit-service.js"
import { NoteCreateInput, plainTextToNoteBody } from "./planning/note-service.js"
import { ReminderCreateInput } from "./planning/reminder-service.js"
import { TaskCreateInput } from "./planning/task-service.js"

/**
 * Capture domain model (ADR-0012; ticket #101).
 *
 * A **Capture** is one free-text submission and its server-side record. A
 * **Dissect** turns the text into **Capture Drafts** — proposals that are not
 * rows — and a **Capture Commit** validates those drafts against the real
 * create schemas and applies them through the existing services.
 *
 * The vocabulary is normative: `GLOSSARY.md` § Capture. "Inbox" stays reserved
 * for the Missed Inbox.
 *
 * ## Drafts derive from the create inputs
 *
 * Each draft variant takes its field *schemas* from the aggregate's real create
 * input (`TaskCreateInput.fields.title`, …) so the two can never drift. The
 * key lists below are the Capture policy — a subset of the create fields,
 * every one optional — not a second schema. Fields a Capture run must never
 * invent (`id`, `clientMutationId`, `visibility`, projects, tags, links,
 * exceptions, occasions) are deliberately absent.
 *
 * ## The commit is not a transaction
 *
 * `toCreateInput` is the single conversion from a draft to the service input:
 * it fills the enumerable silent defaults, wraps a Note's plain text into the
 * minimal ProseMirror document, normalizes ISO offsets to UTC, then runs the
 * real create schema. One invalid draft fails the whole request before
 * anything is written.
 */

// ── Bounds and windows (ADR-0012 §9) ─────────────────────────────────────

/** 4000-character input cap. */
export const CAPTURE_MAX_TEXT_LENGTH = 4000
/** At most this many drafts come back from one Dissect. */
export const CAPTURE_MAX_DRAFTS = 12
/** Identical text inside this window returns the existing Capture. */
export const CAPTURE_DEDUPE_WINDOW_MS = 60_000
/** Capture rows are purged after this many days by the maintenance cron. */
export const CAPTURE_RETENTION_DAYS = 90
export const CAPTURE_RETENTION_MS = CAPTURE_RETENTION_DAYS * 24 * 60 * 60 * 1000

// ── Identity and status ───────────────────────────────────────────────────

/** A Capture is owner-only and outside sync, so its id is a plain UUID v7. */
export const CaptureId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("CaptureId")
)
export type CaptureId = Schema.Schema.Type<typeof CaptureId>

/** The lifecycle in `GLOSSARY.md` § Capture Status. */
export const CaptureStatus = Schema.Literals([
  "pending",
  "parsed",
  "failed",
  "committed"
])
export type CaptureStatus = Schema.Schema.Type<typeof CaptureStatus>

/** The five aggregates a Dissect may propose. */
export const CaptureDraftKind = Schema.Literals([
  "task",
  "event",
  "note",
  "habit",
  "reminder"
])
export type CaptureDraftKind = Schema.Schema.Type<typeof CaptureDraftKind>

// ── Needs Input (ADR-0012 §4) ─────────────────────────────────────────────

/**
 * The typed picker a Needs Input entry renders. It is never a free-text
 * answer and never a second model call.
 */
export const NeedsInputShape = Schema.Literals([
  "instant",
  "localDate",
  "clockTime",
  "frequency",
  "repeat"
])
export type NeedsInputShape = Schema.Schema.Type<typeof NeedsInputShape>

/**
 * One field the text does not supply and the model may not invent.
 *
 * `field` is the draft field name the picker writes; `question` is the Persian
 * copy shown on the card. The entry is removed when the user answers it.
 * `normalizeCaptureDraftInput` folds the model's common aliases (`endTime`)
 * into the names the review cards implement.
 */
export const NeedsInput = Schema.Struct({
  field: Schema.String.check(Schema.isMinLength(1)),
  shape: NeedsInputShape,
  question: Schema.String.check(Schema.isMinLength(1))
})
export type NeedsInput = Schema.Schema.Type<typeof NeedsInput>

/** The verbatim slice of the Capture text a draft was built from. */
export const SourceQuote = Schema.String.check(Schema.isMinLength(1))
export type SourceQuote = Schema.Schema.Type<typeof SourceQuote>

// ── Drafts (ADR-0012 §3) ──────────────────────────────────────────────────

const draftEnvelope = {
  sourceQuote: SourceQuote,
  /** Fields the text does not supply; a non-empty list blocks the commit. */
  missing: Schema.Array(NeedsInput)
} as const

/**
 * A proposed task. Fields come from `TaskCreateInput`; `title` and the due
 * shape are the card-editable structural fields.
 */
export const TaskDraft = Schema.Struct({
  _tag: Schema.Literal("task"),
  title: Schema.optional(TaskCreateInput.fields.title),
  description: Schema.optional(TaskCreateInput.fields.description),
  status: Schema.optional(TaskCreateInput.fields.status),
  priority: Schema.optional(TaskCreateInput.fields.priority),
  dueAt: Schema.optional(TaskCreateInput.fields.dueAt),
  dueDate: Schema.optional(TaskCreateInput.fields.dueDate),
  timeZone: Schema.optional(TaskCreateInput.fields.timeZone),
  recurrence: Schema.optional(TaskCreateInput.fields.recurrence),
  recurrenceMode: Schema.optional(TaskCreateInput.fields.recurrenceMode),
  color: Schema.optional(TaskCreateInput.fields.color),
  ...draftEnvelope
})
export type TaskDraft = Schema.Schema.Type<typeof TaskDraft>

/** A proposed event. `timing` is the structural field the card edits. */
export const EventDraft = Schema.Struct({
  _tag: Schema.Literal("event"),
  title: Schema.optional(EventCreateInput.fields.title),
  description: Schema.optional(EventCreateInput.fields.description),
  location: Schema.optional(EventCreateInput.fields.location),
  category: Schema.optional(EventCreateInput.fields.category),
  color: Schema.optional(EventCreateInput.fields.color),
  people: Schema.optional(EventCreateInput.fields.people),
  timing: Schema.optional(EventCreateInput.fields.timing),
  timeZone: Schema.optional(EventCreateInput.fields.timeZone),
  recurrence: Schema.optional(EventCreateInput.fields.recurrence),
  ...draftEnvelope
})
export type EventDraft = Schema.Schema.Type<typeof EventDraft>

/**
 * A proposed note. `body` is plain text — the model never authors a
 * ProseMirror tree; the commit wraps it.
 */
export const NoteDraft = Schema.Struct({
  _tag: Schema.Literal("note"),
  title: Schema.optional(NoteCreateInput.fields.title),
  body: Schema.optional(Schema.String),
  isPinned: Schema.optional(NoteCreateInput.fields.isPinned),
  isArchived: Schema.optional(NoteCreateInput.fields.isArchived),
  color: Schema.optional(NoteCreateInput.fields.color),
  ...draftEnvelope
})
export type NoteDraft = Schema.Schema.Type<typeof NoteDraft>

/** A proposed habit. `frequency` is the structural field the card edits. */
export const HabitDraft = Schema.Struct({
  _tag: Schema.Literal("habit"),
  title: Schema.optional(HabitCreateInput.fields.title),
  description: Schema.optional(HabitCreateInput.fields.description),
  color: Schema.optional(HabitCreateInput.fields.color),
  icon: Schema.optional(HabitCreateInput.fields.icon),
  frequency: Schema.optional(HabitCreateInput.fields.frequency),
  reminderTime: Schema.optional(HabitCreateInput.fields.reminderTime),
  timeZone: Schema.optional(HabitCreateInput.fields.timeZone),
  ...draftEnvelope
})
export type HabitDraft = Schema.Schema.Type<typeof HabitDraft>

/** A proposed reminder. `repeat` is the structural field the card edits. */
export const ReminderDraft = Schema.Struct({
  _tag: Schema.Literal("reminder"),
  title: Schema.optional(ReminderCreateInput.fields.title),
  note: Schema.optional(ReminderCreateInput.fields.note),
  kind: Schema.optional(ReminderCreateInput.fields.kind),
  repeat: Schema.optional(ReminderCreateInput.fields.repeat),
  fireAt: Schema.optional(ReminderCreateInput.fields.fireAt),
  offsetMinutes: Schema.optional(ReminderCreateInput.fields.offsetMinutes),
  silencedUntil: Schema.optional(ReminderCreateInput.fields.silencedUntil),
  timeZone: Schema.optional(ReminderCreateInput.fields.timeZone),
  color: Schema.optional(ReminderCreateInput.fields.color),
  ...draftEnvelope
})
export type ReminderDraft = Schema.Schema.Type<typeof ReminderDraft>

/** The discriminated union a Dissect collects and a review screen renders. */
export const CaptureDraft = Schema.Union([
  TaskDraft,
  EventDraft,
  NoteDraft,
  HabitDraft,
  ReminderDraft
])
export type CaptureDraft = Schema.Schema.Type<typeof CaptureDraft>

// ── The Capture row (ADR-0012 §6) ─────────────────────────────────────────

/** A row a Capture Commit wrote, kept so the result strip can link to it. */
export const CaptureCreatedRow = Schema.Struct({
  type: CaptureDraftKind,
  id: Schema.String,
  title: Schema.String
})
export type CaptureCreatedRow = Schema.Schema.Type<typeof CaptureCreatedRow>

/**
 * The server's record of one submission. Owner-only, outside the sync
 * machinery: no version, no feed entry, no household scope.
 */
export const Capture = Schema.Struct({
  id: CaptureId,
  ownerId: UserId,
  text: Schema.String,
  status: CaptureStatus,
  drafts: Schema.Array(CaptureDraft),
  createdIds: Schema.Array(CaptureCreatedRow),
  /** The model/network failure message while `status` is `failed`. */
  error: Schema.NullOr(Schema.String),
  createdAt: TimestampUtc,
  committedAt: Schema.NullOr(TimestampUtc)
})
export type Capture = Schema.Schema.Type<typeof Capture>

// ── RPC inputs and results ────────────────────────────────────────────────

/** `DissectCapture` payload: the raw text box contents. */
export const DissectCaptureInput = Schema.Struct({
  text: Schema.String
})
export type DissectCaptureInput = Schema.Schema.Type<typeof DissectCaptureInput>

/**
 * `CommitCapture` payload: the reviewed drafts, in their original order.
 *
 * The client resends the whole list on a retry; each draft's deterministic
 * replay key makes the earlier writes no-ops.
 */
export const CommitCaptureInput = Schema.Struct({
  captureId: CaptureId,
  drafts: Schema.Array(CaptureDraft)
})
export type CommitCaptureInput = Schema.Schema.Type<typeof CommitCaptureInput>

/** `ListCaptures` payload: the history screen's page size. */
export const ListCapturesInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
})
export type ListCapturesInput = Schema.Schema.Type<typeof ListCapturesInput>

/** `DeleteCapture` payload: one history row to drop. */
export const DeleteCaptureInput = Schema.Struct({
  captureId: CaptureId
})
export type DeleteCaptureInput = Schema.Schema.Type<typeof DeleteCaptureInput>

/** A mid-way service failure, reported without discarding what landed. */
export const CaptureCommitFailure = Schema.Struct({
  draftIndex: Schema.Int,
  error: Schema.String
})
export type CaptureCommitFailure = Schema.Schema.Type<typeof CaptureCommitFailure>

/** The commit result: the stored Capture plus the rows this attempt landed. */
export const CaptureCommitResult = Schema.Struct({
  capture: Capture,
  created: Schema.Array(CaptureCreatedRow),
  failure: Schema.NullOr(CaptureCommitFailure),
  remaining: Schema.Int
})
export type CaptureCommitResult = Schema.Schema.Type<typeof CaptureCommitResult>

// ── Typed errors (`docs/error-model-draft.md` §2) ─────────────────────────

/** The text exceeds the 4000-character cap. */
export class CaptureTooLong extends Schema.TaggedError<CaptureTooLong>()(
  "CaptureTooLong",
  { length: Schema.Int, max: Schema.Int }
) {}

/** Empty or whitespace-only input never reaches the model. */
export class CaptureEmpty extends Schema.TaggedError<CaptureEmpty>()("CaptureEmpty", {}) {}

/** The per-user hourly window is exhausted. */
export class CaptureRateLimited extends Schema.TaggedError<CaptureRateLimited>()(
  "CaptureRateLimited",
  { retryAfterSeconds: Schema.Int }
) {}

/** The model call could not start or failed; the Capture row stays retryable. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  "ModelUnavailable",
  { message: Schema.String }
) {}

/** The model call exceeded the 60-second budget (including its one retry). */
export class ModelTimeout extends Schema.TaggedError<ModelTimeout>()("ModelTimeout", {
  seconds: Schema.Int
}) {}

/** A draft failed its real create schema; nothing was written. */
export class InvalidDraft extends Schema.TaggedError<InvalidDraft>()("InvalidDraft", {
  draftIndex: Schema.Int,
  field: Schema.String,
  message: Schema.String
}) {}

/** A required field is still absent (usually an unanswered Needs Input). */
export class DraftIncomplete extends Schema.TaggedError<DraftIncomplete>()(
  "DraftIncomplete",
  { draftIndex: Schema.Int, fields: Schema.Array(Schema.String) }
) {}

/** The Capture row does not exist or belongs to another owner. */
export class CaptureNotFound extends Schema.TaggedError<CaptureNotFound>()(
  "CaptureNotFound",
  { id: CaptureId }
) {}

/** The viewer cannot use Capture (no household yet). */
export class CaptureForbidden extends Schema.TaggedError<CaptureForbidden>()(
  "CaptureForbidden",
  { reason: Schema.Literals(["private", "household", "noHousehold"]) }
) {}

export const CaptureServiceError = Schema.Union([
  CaptureTooLong,
  CaptureEmpty,
  CaptureRateLimited,
  ModelUnavailable,
  ModelTimeout,
  InvalidDraft,
  DraftIncomplete,
  CaptureNotFound,
  CaptureForbidden
])
export type CaptureServiceError = Schema.Schema.Type<typeof CaptureServiceError>

// ── Text normalization (ADR-0012 §8) ──────────────────────────────────────

/**
 * The text as it is stored and compared: line endings normalized and outer
 * whitespace trimmed. The user's wording is never rewritten.
 */
export const normalizeCaptureText = (text: string): string =>
  text.replace(/\r\n?/g, "\n").trim()

/**
 * The dedupe key: the same Persian folding the search path uses, so two
 * spellings of one sentence do not pay for two model runs.
 */
export const captureDedupeKey = (text: string): string =>
  normalizePersian(normalizeCaptureText(text))

/** Persian/Arabic-Indic digits to ASCII for a validated field value. */
export const normalizeCaptureDigits = (value: string): string => toLatinDigits(value).trim()

/**
 * An ISO instant normalized to UTC `Z`.
 *
 * Models emit `+03:30` offsets; the stored domain instant is UTC, and the
 * create schemas do not require a particular offset. Normalizing here keeps a
 * correct answer from being rejected and makes replay hashes stable.
 */
export const normalizeCaptureInstant = (value: string): string => {
  const trimmed = normalizeCaptureDigits(value)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString()
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const normalizeDigitsValue = (value: unknown): unknown =>
  typeof value === "string" ? normalizeCaptureDigits(value) : value

const normalizeInstantValue = (value: unknown): unknown =>
  typeof value === "string" ? normalizeCaptureInstant(value) : value

const normalizeNumberValue = (value: unknown): unknown => {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Number(normalizeCaptureDigits(value))
    return Number.isNaN(parsed) ? value : parsed
  }
  return value
}

const normalizeNumberArray = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(normalizeNumberValue) : value

const normalizeTimingInput = (value: unknown): unknown => {
  const record = asRecord(value)
  if (record === undefined) return value
  if (record._tag === "timed") {
    return {
      ...record,
      start: normalizeInstantValue(record.start),
      end: normalizeInstantValue(record.end)
    }
  }
  if (record._tag === "allDay") {
    return { ...record, date: normalizeDigitsValue(record.date) }
  }
  return value
}

const normalizeRecurrenceInput = (value: unknown): unknown => {
  const record = asRecord(value)
  if (record === undefined) return value
  const end = asRecord(record.end)
  const nthWeekday = asRecord(record.nthWeekday)
  return {
    ...record,
    interval: normalizeNumberValue(record.interval),
    byDay: normalizeNumberArray(record.byDay),
    byMonthDay: normalizeNumberArray(record.byMonthDay),
    ...(nthWeekday === undefined
      ? {}
      : {
        nthWeekday: {
          ...nthWeekday,
          nth: normalizeNumberValue(nthWeekday.nth),
          day: normalizeNumberValue(nthWeekday.day)
        }
      }),
    ...(end === undefined
      ? {}
      : {
        end: end._tag === "until"
          ? { ...end, date: normalizeDigitsValue(end.date) }
          : end._tag === "count"
          ? { ...end, count: normalizeNumberValue(end.count) }
          : end
      })
  }
}

const normalizeFrequencyInput = (value: unknown): unknown => {
  const record = asRecord(value)
  if (record === undefined) return value
  if (record._tag === "weekdays") {
    return { ...record, days: normalizeNumberArray(record.days) }
  }
  if (record._tag === "weekly") {
    return { ...record, times: normalizeNumberValue(record.times) }
  }
  return value
}

const normalizeRepeatInput = (value: unknown): unknown => {
  const record = asRecord(value)
  if (record === undefined) return value
  if (record._tag === "daily") {
    return { ...record, time: normalizeDigitsValue(record.time) }
  }
  if (record._tag === "weekly") {
    return {
      ...record,
      days: normalizeNumberArray(record.days),
      time: normalizeDigitsValue(record.time)
    }
  }
  if (record._tag === "interval") {
    return { ...record, hours: normalizeNumberValue(record.hours) }
  }
  return value
}

/**
 * The model names a Needs Input field in its own words now and then
 * (`endTime`); the review card only knows the canonical draft fields. Fold the
 * observed aliases before validation so the answer lands in the right field.
 */
const MISSING_FIELD_ALIASES: Readonly<Record<string, string>> = {
  startTime: "timing.start",
  startsAt: "timing.start",
  start_at: "timing.start",
  endTime: "timing.end",
  endsAt: "timing.end",
  end_at: "timing.end"
}

const normalizeMissingInput = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((entry) => {
      const record = asRecord(entry)
      if (record === undefined) return entry
      const field = typeof record.field === "string"
        ? MISSING_FIELD_ALIASES[record.field] ?? record.field
        : record.field
      return { ...record, field }
    })
    : value

/**
 * Normalize the structural fields of a raw tool input before it is validated.
 *
 * Only validated field values are touched — never `title`, `description`,
 * `body`, `note`, `sourceQuote` or the Needs Input questions, which are the
 * user's own wording. The model's `+03:30` instants become UTC `Z`, and
 * Persian/Arabic-Indic digits in dates, times and counts become ASCII.
 */
export const normalizeCaptureDraftInput = (
  input: Record<string, unknown>
): Record<string, unknown> => ({
  ...input,
  ...(input.dueAt !== undefined ? { dueAt: normalizeInstantValue(input.dueAt) } : {}),
  ...(input.dueDate !== undefined ? { dueDate: normalizeDigitsValue(input.dueDate) } : {}),
  ...(input.fireAt !== undefined ? { fireAt: normalizeInstantValue(input.fireAt) } : {}),
  ...(input.silencedUntil !== undefined
    ? {
      silencedUntil: input.silencedUntil === null
        ? null
        : normalizeInstantValue(input.silencedUntil)
    }
    : {}),
  ...(input.reminderTime !== undefined
    ? { reminderTime: normalizeDigitsValue(input.reminderTime) }
    : {}),
  ...(input.timeZone !== undefined ? { timeZone: normalizeDigitsValue(input.timeZone) } : {}),
  ...(input.offsetMinutes !== undefined
    ? { offsetMinutes: normalizeNumberValue(input.offsetMinutes) }
    : {}),
  ...(input.timing !== undefined ? { timing: normalizeTimingInput(input.timing) } : {}),
  ...(input.recurrence !== undefined
    ? { recurrence: normalizeRecurrenceInput(input.recurrence) }
    : {}),
  ...(input.frequency !== undefined
    ? { frequency: normalizeFrequencyInput(input.frequency) }
    : {}),
  ...(input.repeat !== undefined ? { repeat: normalizeRepeatInput(input.repeat) } : {}),
  ...(input.missing !== undefined ? { missing: normalizeMissingInput(input.missing) } : {})
})

// ── Draft → real create input (ADR-0012 §5) ───────────────────────────────

/** The context a commit supplies to one draft. */
export interface CaptureCommitContext {
  /** The draft's position in the reviewed list; names the failing card. */
  readonly draftIndex: number
  /** `f(captureId, draftIndex, draftHash)`; the replay key. */
  readonly clientMutationId: string
  /** The viewer's zone, used when the draft did not carry one. */
  readonly timeZone: string
}

/** The create input a draft becomes, tagged by aggregate. */
export const CaptureCreateInput = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("task"), input: TaskCreateInput }),
  Schema.Struct({ _tag: Schema.Literal("event"), input: EventCreateInput }),
  Schema.Struct({ _tag: Schema.Literal("note"), input: NoteCreateInput }),
  Schema.Struct({ _tag: Schema.Literal("habit"), input: HabitCreateInput }),
  Schema.Struct({ _tag: Schema.Literal("reminder"), input: ReminderCreateInput })
])
export type CaptureCreateInput = Schema.Schema.Type<typeof CaptureCreateInput>

const incomplete = (
  context: CaptureCommitContext,
  fields: ReadonlyArray<string>
): Effect.Effect<never, DraftIncomplete> =>
  Effect.fail(new DraftIncomplete({ draftIndex: context.draftIndex, fields: [...fields] }))

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

const validateCreateInput = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: unknown,
  draftIndex: number
): Effect.Effect<S["Type"], InvalidDraft> => {
  const result = Schema.decodeUnknownResult(schema)(raw)
  if (Result.isFailure(result)) {
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues
    const first = issues[0]
    return Effect.fail(
      new InvalidDraft({
        draftIndex,
        field: first?.path === undefined ? "" : first.path.map(String).join("."),
        message: first?.message ?? result.failure.message
      })
    )
  }
  return Effect.succeed(result.success)
}

/**
 * Turn one reviewed draft into the real create input.
 *
 * It applies the enumerable silent defaults (task `todo`, reminder `general`,
 * habit `daily`), wraps a note's plain text, normalizes offsets to UTC, and
 * then decodes with the aggregate's real create schema. A missing required
 * field is a typed `DraftIncomplete`; a malformed value is a typed
 * `InvalidDraft` naming the field.
 */
export const toCreateInput = (
  draft: CaptureDraft,
  context: CaptureCommitContext
): Effect.Effect<CaptureCreateInput, InvalidDraft | DraftIncomplete> =>
  Effect.gen(function*() {
    switch (draft._tag) {
      case "task": {
        if (draft.title === undefined) {
          return yield* incomplete(context, ["title"])
        }
        const raw = {
          clientMutationId: context.clientMutationId,
          title: draft.title,
          status: draft.status ?? "todo",
          timeZone: draft.timeZone ?? context.timeZone,
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          ...(draft.priority !== undefined ? { priority: draft.priority } : {}),
          ...(draft.dueAt !== undefined
            ? {
              dueAt: draft.dueAt === null
                ? null
                : normalizeCaptureInstant(draft.dueAt)
            }
            : {}),
          ...(draft.dueDate !== undefined ? { dueDate: draft.dueDate } : {}),
          ...(draft.recurrence !== undefined ? { recurrence: draft.recurrence } : {}),
          ...(draft.recurrenceMode !== undefined
            ? { recurrenceMode: draft.recurrenceMode }
            : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {})
        }
        const input = yield* validateCreateInput(TaskCreateInput, raw, context.draftIndex)
        return { _tag: "task" as const, input }
      }

      case "event": {
        const missing: Array<string> = []
        if (draft.title === undefined) missing.push("title")
        if (draft.timing === undefined) missing.push("timing")
        if (missing.length > 0) {
          return yield* incomplete(context, missing)
        }
        const timing: EventTiming = draft.timing!._tag === "timed"
          ? {
            _tag: "timed",
            start: normalizeCaptureInstant(draft.timing!.start),
            end: normalizeCaptureInstant(draft.timing!.end)
          }
          : draft.timing!
        const raw = {
          clientMutationId: context.clientMutationId,
          title: draft.title!,
          timing,
          timeZone: draft.timeZone ?? context.timeZone,
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          ...(draft.location !== undefined ? { location: draft.location } : {}),
          ...(draft.category !== undefined ? { category: draft.category } : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {}),
          ...(draft.people !== undefined ? { people: draft.people } : {}),
          ...(draft.recurrence !== undefined ? { recurrence: draft.recurrence } : {})
        }
        const input = yield* validateCreateInput(EventCreateInput, raw, context.draftIndex)
        return { _tag: "event" as const, input }
      }

      case "note": {
        const bodyText = draft.body ?? draft.title ?? ""
        const title = draft.title ?? firstLine(bodyText)
        if (bodyText.trim() === "" && title.trim() === "") {
          return yield* incomplete(context, ["title", "body"])
        }
        const raw = {
          clientMutationId: context.clientMutationId,
          title,
          body: plainTextToNoteBody(bodyText),
          plainText: bodyText,
          ...(draft.isPinned !== undefined ? { isPinned: draft.isPinned } : {}),
          ...(draft.isArchived !== undefined ? { isArchived: draft.isArchived } : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {})
        }
        const input = yield* validateCreateInput(NoteCreateInput, raw, context.draftIndex)
        return { _tag: "note" as const, input }
      }

      case "habit": {
        if (draft.title === undefined) {
          return yield* incomplete(context, ["title"])
        }
        const frequency: HabitFrequency = draft.frequency ?? { _tag: "daily" }
        const raw = {
          clientMutationId: context.clientMutationId,
          title: draft.title,
          frequency,
          timeZone: draft.timeZone ?? context.timeZone,
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {}),
          ...(draft.icon !== undefined ? { icon: draft.icon } : {}),
          ...(draft.reminderTime !== undefined
            ? { reminderTime: draft.reminderTime }
            : {})
        }
        const input = yield* validateCreateInput(HabitCreateInput, raw, context.draftIndex)
        return { _tag: "habit" as const, input }
      }

      case "reminder": {
        const missing: Array<string> = []
        if (draft.title === undefined) missing.push("title")
        if (draft.repeat === undefined) missing.push("repeat")
        if (
          draft.repeat?._tag === "once" &&
          draft.fireAt === undefined
        ) {
          missing.push("fireAt")
        }
        if (missing.length > 0) {
          return yield* incomplete(context, missing)
        }
        const repeat: ReminderRepeat = draft.repeat!
        const raw = {
          clientMutationId: context.clientMutationId,
          title: draft.title!,
          kind: draft.kind ?? "general",
          repeat,
          timeZone: draft.timeZone ?? context.timeZone,
          ...(draft.note !== undefined ? { note: draft.note } : {}),
          ...(draft.fireAt !== undefined
            ? {
              fireAt: draft.fireAt === null
                ? null
                : normalizeCaptureInstant(draft.fireAt)
            }
            : {}),
          ...(draft.offsetMinutes !== undefined
            ? { offsetMinutes: draft.offsetMinutes }
            : {}),
          ...(draft.silencedUntil !== undefined
            ? {
              silencedUntil: draft.silencedUntil === null
                ? null
                : normalizeCaptureInstant(draft.silencedUntil)
            }
            : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {})
        }
        const input = yield* validateCreateInput(ReminderCreateInput, raw, context.draftIndex)
        return { _tag: "reminder" as const, input }
      }
    }
  })

// ── Card picker helpers (shared by the review UI) ─────────────────────────

/**
 * A local date + clock time in an IANA zone as a UTC instant.
 *
 * The review card edits a local wall time; the domain stores UTC. Pure, so the
 * client can convert before it sends the reviewed draft and the server never
 * has to guess which offset the user meant.
 */
export const localDateTimeToInstant = (
  localDate: string,
  clockTime: string,
  timeZone: string
): string =>
  Temporal.PlainDateTime.from(`${localDate}T${clockTime}`)
    .toZonedDateTime(timeZone)
    .toInstant()
    .toString()

/** The local date (`YYYY-MM-DD`) and `HH:mm` of a UTC instant in a zone. */
export const instantToLocalParts = (
  instant: string,
  timeZone: string
): { readonly date: string; readonly time: string } => {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)
  return {
    date: zoned.toPlainDate().toString(),
    time: zoned.toPlainTime().toString({ smallestUnit: "minute" })
  }
}

/** The prompt context the extractor needs from the viewer (ADR-0012 §8). */
export interface CaptureContext {
  /** The Dissect's "now", an ISO instant. */
  readonly now: string
  /** The owner's IANA zone. */
  readonly timeZone: string
  /** The display week start; it is part of the prompt's reproducibility. */
  readonly weekStart: WeekStart
}
