import { Effect, Ref, Result, Schema, SchemaIssue } from 'effect'
import { toolDefinition } from '@tanstack/ai'
import { serverTool, toolSchema } from '@tanstack/ai-effect'
import {
  type CaptureDraft,
  type CaptureDraftKind,
  EventDraft,
  HabitDraft,
  InvalidDraft,
  NoteDraft,
  ReminderDraft,
  TaskDraft,
  normalizeCaptureDraftInput,
} from '@tali/domain'

/**
 * The five draft tools a Dissect run may call (ADR-0012 §1–§2; ticket #101).
 *
 * Each tool:
 *
 * - has its own tight schema (a per-aggregate tool, never a discriminated
 *   `add_item` union) and a Persian description of when to use it;
 * - normalizes the structural fields (Persian digits → ASCII, `+03:30` →
 *   UTC `Z`) before validating;
 * - validates the input against the **draft** schema, which derives its field
 *   schemas from the aggregate's real create input;
 * - appends the draft to a per-run `Ref` and returns a small acknowledgement.
 *
 * No tool holds a D1 handle. A failure becomes a tool error whose message names
 * the failing field; TanStack AI hands that back to the model, which repairs
 * the call inside the same run.
 */

const issueField = (
  issue: SchemaIssue.Issue,
): { field: string; message: string } => {
  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues
  const first = issues[0]
  return {
    field: first?.path === undefined ? '' : first.path.map(String).join('.'),
    message: first?.message ?? 'invalid draft',
  }
}

/**
 * A draft the model can repair inside the run. TanStack AI hands the message
 * back as a tool error, so it names the failing field first.
 */
class DraftToolRejected extends Schema.TaggedError<DraftToolRejected>()(
  'DraftToolRejected',
  {
    /** The draft field whose value failed validation. */
    field: Schema.String,
    /** The model-facing sentence, which leads with the field name. */
    message: Schema.String,
  },
) {}

/**
 * Validate one raw tool call against its draft schema.
 *
 * `sourceQuote` is checked against the Capture text first: it must be an exact
 * slice, because the review card's trust signal is "that is the sentence I
 * meant". A paraphrase is a tool error, not a silently accepted draft.
 */
const decodeDraft =
  <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    tag: CaptureDraftKind,
    text: string,
  ) =>
  (raw: Record<string, unknown>): Effect.Effect<S['Type'], InvalidDraft> => {
    const sourceQuote =
      typeof raw.sourceQuote === 'string' ? raw.sourceQuote.trim() : ''
    if (sourceQuote === '' || !text.includes(sourceQuote)) {
      return Effect.fail(
        new InvalidDraft({
          draftIndex: -1,
          field: 'sourceQuote',
          message:
            'sourceQuote must be an exact, non-empty slice of the Capture text',
        }),
      )
    }

    const result = Schema.decodeResult(schema)({
      ...raw,
      _tag: tag,
      sourceQuote,
    })
    if (Result.isFailure(result)) {
      const { field, message } = issueField(result.failure.issue)
      return Effect.fail(new InvalidDraft({ draftIndex: -1, field, message }))
    }
    return Effect.succeed(result.success)
  }

interface DraftToolConfig<D extends CaptureDraft> {
  readonly name: string
  readonly description: string
  readonly fields: Schema.Struct.Fields
  readonly decode: (
    raw: Record<string, unknown>,
  ) => Effect.Effect<D, InvalidDraft>
}

/**
 * Turn a draft tool definition into a TanStack AI server tool whose `execute`
 * is an Effect. The model never sees the `_tag`; the collector stores the
 * tagged draft.
 */
const makeDraftTool = <D extends CaptureDraft>(
  collector: Ref.Ref<ReadonlyArray<CaptureDraft>>,
  config: DraftToolConfig<D>,
) =>
  serverTool(
    toolDefinition({
      name: config.name,
      description: config.description,
      inputSchema: toolSchema(Schema.Struct(config.fields)),
    }),
    input =>
      Effect.gen(function* () {
        const raw = normalizeCaptureDraftInput(input)
        const draft = yield* config.decode(raw).pipe(
          // The model reads this message; name the field so its next call can
          // repair exactly the malformed value.
          Effect.mapError(
            error =>
              new DraftToolRejected({
                field: error.field,
                message: `invalid ${error.field}: ${error.message}`,
              }),
          ),
        )
        yield* Ref.update(collector, drafts => [...drafts, draft])
        return { accepted: true as const }
      }),
  )

/** The draft fields without the discriminator the model must not supply. */
const withoutTag = (fields: Schema.Struct.Fields): Schema.Struct.Fields => {
  const { _tag: _ignored, ...rest } = fields
  return rest
}

/**
 * The five tools of one Dissect run, all appending to the same per-run `Ref`.
 *
 * `text` is the Capture's original text, used only for the verbatim
 * `sourceQuote` check.
 */
export const makeDraftTools = (
  collector: Ref.Ref<ReadonlyArray<CaptureDraft>>,
  text: string,
) => {
  const task = makeDraftTool(collector, {
    name: 'draft_task',
    description:
      'یک کار مشخص و قابل انجام را پیشنهاد بده. برای هر نیت جداگانه یک بار صدا بزن؛ دو کار را در یک فراخوانی ادغام نکن.',
    fields: withoutTag(TaskDraft.fields),
    decode: decodeDraft(TaskDraft, 'task', text),
  })

  const event = makeDraftTool(collector, {
    name: 'draft_event',
    description:
      'یک رویداد تقویمی (قرار، جلسه، سفر) را پیشنهاد بده. اگر متن روز را می‌گوید ولی ساعت را نمی‌گوید، allDay بگذار. بدون روز، فیلد timing را در missing بگذار.',
    fields: withoutTag(EventDraft.fields),
    decode: decodeDraft(EventDraft, 'event', text),
  })

  const note = makeDraftTool(collector, {
    name: 'draft_note',
    description:
      'متن غیرقابل‌اقدام یا یک ایده/یادداشت را پیشنهاد بده. body متن ساده است، نه ProseMirror. عنوان از خط اول.',
    fields: withoutTag(NoteDraft.fields),
    decode: decodeDraft(NoteDraft, 'note', text),
  })

  const habit = makeDraftTool(collector, {
    name: 'draft_habit',
    description:
      'یک عادت تکرارشونده (ورزش، کتاب، دارو) را پیشنهاد بده. اگر ریتم گفته نشده، frequency را خالی بگذار تا daily پیش‌فرض شود؛ ریتمی که متن نمی‌گوید را از خودت نساز.',
    fields: withoutTag(HabitDraft.fields),
    decode: decodeDraft(HabitDraft, 'habit', text),
  })

  const reminder = makeDraftTool(collector, {
    name: 'draft_reminder',
    description:
      'یک یادآوری (دارو، کار خانه، قرار) را پیشنهاد بده. kind پیش‌فرض general است. اگر زمان تکرار یا fireAt در متن نیست، آن را در missing بگذار؛ زمان از خودت نساز.',
    fields: withoutTag(ReminderDraft.fields),
    decode: decodeDraft(ReminderDraft, 'reminder', text),
  })

  return [task, event, note, habit, reminder] as const
}
