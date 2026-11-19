import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import {
  defaultVisibilityFor,
  type DispatchResponse,
  type HouseholdId,
  type PushOutcome,
  Reminder,
  ReminderDispatch,
  type ReminderDispatchId,
  type ReminderId,
  type ReminderInboxItem,
  ReminderLink,
  type ReminderLinkColumns,
  ReminderRepeat,
  type ReminderTier,
  type ReminderType,
  type UserId,
  type Visibility,
  decodeReminderLink,
  encodeReminderLink,
  noReminderLink,
  onceReminderRepeat,
} from '@tali/domain'
import {
  type ColumnCodec,
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql, type VisibleScopeOptions } from './scope'

/**
 * D1 persistence for the `Reminder` aggregate and its dispatch ledger
 * (ticket #60; ADR-0005).
 *
 * Pure persistence: ids, `tier`/`fireAt` derivation, version bumps and the
 * "silence expires owed rows" rule belong to `ReminderService`. D1 has no
 * interactive transactions, so a write that also touches the change feed is
 * assembled by the caller as one `D1Client.batch()`.
 *
 * ## Flattened union columns
 *
 * `repeat` is JSON text (the structured union from §3.6), and `link` is stored
 * as `link_type` + `link_id` rather than nullable foreign keys, so the invalid
 * state "linked to two things" is not representable.
 */

const asLink = Schema.decodeUnknownOption(ReminderLink)

/**
 * The link union, decoded defensively; a malformed value reads as unlinked,
 * exactly like the registry's hand-written statements did.
 */
const reminderLinkOf = (value: unknown): ReminderLink =>
  Option.getOrElse(asLink(value), noReminderLink)

/**
 * The link union's two physical columns, as per-column codecs on the one
 * `link` field (#115): the flattened pair is always consistent — a row can
 * never claim two links.
 */
const linkTypeCodec: ColumnCodec = value =>
  encodeReminderLink(reminderLinkOf(value)).linkType
const linkIdCodec: ColumnCodec = value =>
  encodeReminderLink(reminderLinkOf(value)).linkId

/**
 * The one place `reminders`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements, are all generated from this descriptor. The dispatch ledger
 * (`reminder_dispatches`) is server-written only and not a synced aggregate;
 * its statements stay hand-written below.
 */
export const REMINDER_TABLE = defineTable('reminders', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('note', { codec: columnCodecs.nullableText }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('kind', { codec: columnCodecs.text }),
  column('tier', { codec: columnCodecs.text }),
  column('repeat', { codec: columnCodecs.json }),
  column('offset_minutes', 'offsetMinutes', { codec: columnCodecs.int }),
  column('fire_at', 'fireAt', { codec: columnCodecs.text }),
  column('link_type', 'link', {
    as: 'linkType',
    codec: linkTypeCodec,
    mirrors: [{ column: 'link_id', as: 'linkId', codec: linkIdCodec }],
  }),
  column('silenced_until', 'silencedUntil', {
    codec: columnCodecs.nullableText,
  }),
  column('time_zone', 'timeZone', { codec: columnCodecs.text }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

/** The trusted column projection, aliased to the camelCase wire names. */
export const REMINDER_SELECT = selectList(REMINDER_TABLE)

const dispatchColumns = (prefix: string): string =>
  `${prefix}id, ${prefix}reminder_id AS reminderId, ${prefix}user_id AS userId, ` +
  `${prefix}scheduled_for AS scheduledFor, ${prefix}deliver_at AS deliverAt, ` +
  `${prefix}root_scheduled_for AS rootScheduledFor, ${prefix}origin, ` +
  `${prefix}push_outcome AS pushOutcome, ${prefix}attempts, ` +
  `${prefix}last_attempt_at AS lastAttemptAt, ${prefix}parent_dispatch_id AS parentDispatchId, ` +
  `${prefix}response, ${prefix}responded_at AS respondedAt, ` +
  `${prefix}snoozed_until AS snoozedUntil, ${prefix}created_at AS createdAt`

export const REMINDER_DISPATCH_SELECT = dispatchColumns('')

export interface ReminderRow extends Record<string, unknown> {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly note: string | null
  readonly ownerId: string
  readonly householdId: string
  readonly visibility: string
  readonly color: string | null
  readonly kind: string
  readonly tier: string
  /** JSON text of the repeat union. */
  readonly repeat: string
  readonly offsetMinutes: number
  readonly fireAt: string
  readonly linkType: string
  readonly linkId: string | null
  readonly silencedUntil: string | null
  readonly timeZone: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
  readonly deletedAt: string | null
}

export interface ReminderDispatchRow extends Record<string, unknown> {
  readonly id: string
  readonly reminderId: string
  readonly userId: string
  readonly scheduledFor: string
  readonly deliverAt: string
  readonly rootScheduledFor: string
  readonly origin: string
  readonly pushOutcome: string
  readonly attempts: number
  readonly lastAttemptAt: string | null
  readonly parentDispatchId: string | null
  readonly response: string | null
  readonly respondedAt: string | null
  readonly snoozedUntil: string | null
  readonly createdAt: string
}

const asRepeat = Schema.decodeOption(Schema.fromJsonString(ReminderRepeat))

/** A row's repeat union; a malformed cell falls back to a one-off. */
const repeatOf = (value: string): ReminderRepeat =>
  Option.getOrElse(asRepeat(value), onceReminderRepeat)

/** The model's plain shape, built from a D1 row. */
export const reminderPropsOf = (row: ReminderRow) => ({
  id: row.id as Reminder['id'],
  type: 'reminder' as const,
  title: row.title,
  note: row.note,
  kind: row.kind as ReminderType,
  tier: row.tier as ReminderTier,
  repeat: repeatOf(row.repeat),
  fireAt: row.fireAt,
  offsetMinutes: Number(row.offsetMinutes),
  link: decodeReminderLink(row.linkType, row.linkId),
  silencedUntil: row.silencedUntil,
  timeZone: row.timeZone,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt,
})

export const toReminder = (row: ReminderRow): Reminder =>
  new Reminder(reminderPropsOf(row))

export const dispatchPropsOf = (row: ReminderDispatchRow) => ({
  id: row.id as ReminderDispatch['id'],
  reminderId: row.reminderId as ReminderId,
  userId: row.userId as UserId,
  scheduledFor: row.scheduledFor,
  deliverAt: row.deliverAt,
  rootScheduledFor: row.rootScheduledFor,
  origin: row.origin,
  pushOutcome: row.pushOutcome as PushOutcome,
  attempts: Number(row.attempts),
  lastAttemptAt: row.lastAttemptAt,
  parentDispatchId: row.parentDispatchId as ReminderDispatchId | null,
  response: row.response as DispatchResponse | null,
  respondedAt: row.respondedAt,
  snoozedUntil: row.snoozedUntil,
  createdAt: row.createdAt,
})

export const toReminderDispatch = (
  row: ReminderDispatchRow,
): ReminderDispatch => new ReminderDispatch(dispatchPropsOf(row))

/**
 * Flatten a link union for the two columns.
 *
 * Thin alias: the codec lives with the union in `@tali/domain`, this keeps the
 * name this module has always published.
 */
export const linkColumns: (link: ReminderLink) => ReminderLinkColumns =
  encodeReminderLink

/** The model's column values; the descriptor's codecs do the encoding. */
const reminderValues = (
  reminder: Reminder,
): ColumnValues<typeof REMINDER_TABLE> => ({
  id: reminder.id,
  type: reminder.type,
  title: reminder.title,
  note: reminder.note,
  ownerId: reminder.ownerId,
  householdId: reminder.householdId,
  visibility: reminder.visibility,
  color: reminder.color,
  kind: reminder.kind,
  tier: reminder.tier,
  repeat: reminder.repeat,
  offsetMinutes: reminder.offsetMinutes,
  fireAt: reminder.fireAt,
  link: reminder.link,
  silencedUntil: reminder.silencedUntil,
  timeZone: reminder.timeZone,
  createdAt: reminder.createdAt,
  updatedAt: reminder.updatedAt,
  version: reminder.version,
  deletedAt: reminder.deletedAt,
})

export class ReminderRepo extends Context.Service<ReminderRepo>()(
  'ReminderRepo',
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /**
       * ADR-0011: the visibility filter every reminder read shares.
       *
       * `trash` is the caller's choice because the reminder list can include
       * tombstones (the delete undo path); every other read takes the default.
       */
      const visibleScope = (
        input: {
          readonly householdId: string
          readonly userId: UserId
        },
        options?: VisibleScopeOptions,
      ): Statement.Fragment => visibleScopeSql(sql, input, options)

      const findById = (id: ReminderId) =>
        Effect.map(
          sql<ReminderRow>`SELECT ${sql.literal(REMINDER_SELECT)} FROM reminders WHERE id = ${id}`,
          rows => Option.map(Option.fromUndefinedOr(rows[0]), toReminder),
        )

      /**
       * The reminder already materialised for one occasion occurrence, if any.
       *
       * Tombstones count: once the owner deletes a materialised advance reminder,
       * a later materialisation of the same occurrence must not resurrect it. The
       * lookup is by the flattened link plus the exact fire instant, which is the
       * durable key `(occasion, occurrence date)` expands to.
       */
      const findOccasionByFireAt = (input: {
        readonly householdId: string
        readonly occasionId: string
        readonly fireAt: string
      }) =>
        Effect.map(
          sql<ReminderRow>`
          SELECT ${sql.literal(REMINDER_SELECT)} FROM reminders
          WHERE household_id = ${input.householdId}
            AND link_type = 'occasion'
            AND link_id = ${input.occasionId}
            AND fire_at = ${input.fireAt}
          ORDER BY version DESC, id ASC
          LIMIT 1
        `,
          rows => Option.map(Option.fromUndefinedOr(rows[0]), toReminder),
        )

      /**
       * Every occasion-linked reminder in a household whose fire instant falls in
       * `[from, to]`, tombstones included.
       *
       * One read for the sweep's materialisation dedupe (ticket #61): a household
       * has a handful of occasions, and checking each draft with
       * `findOccasionByFireAt` would be one query per draft on *every* tick. The
       * returned keys are `(linkId, fire_at)`; a tombstoned key must be skipped,
       * not recreated.
       */
      const listOccasionLinkedInRange = (input: {
        readonly householdId: string
        readonly from: string
        readonly to: string
        readonly limit: number
      }) =>
        sql<{
          readonly householdId: string
          readonly occasionId: string
          readonly fireAt: string
          readonly deletedAt: string | null
        }>`
        SELECT household_id AS householdId, link_id AS occasionId,
               fire_at AS fireAt, deleted_at AS deletedAt
        FROM reminders
        WHERE household_id = ${input.householdId}
          AND link_type = 'occasion'
          AND fire_at >= ${input.from}
          AND fire_at <= ${input.to}
        ORDER BY fire_at ASC, id ASC
        LIMIT ${input.limit}
      `

      /**
       * Live rows visible to one member: shared reminders plus their own private
       * ones. `includeDeleted` is the undo/trash-aware read and keeps tombstones.
       */
      const listVisible = (input: {
        readonly householdId: string
        readonly userId: UserId
        readonly includeDeleted?: boolean
      }) =>
        Effect.map(
          sql<ReminderRow>`
          SELECT ${sql.literal(REMINDER_SELECT)} FROM reminders
          WHERE ${visibleScope(input, {
            trash: input.includeDeleted === true ? 'include' : 'exclude',
          })}
          ORDER BY fire_at ASC, id ASC
        `,
          rows => rows.map(toReminder),
        )

      const insert = (reminder: Reminder) =>
        Effect.map(
          insertStatement<ReminderRow>(sql, REMINDER_TABLE, {
            values: reminderValues(reminder),
            returning: REMINDER_SELECT,
          }),
          rows => toReminder(rows[0]!),
        )

      /**
       * Full-row update. The caller owns the version CAS (`WHERE id AND
       * version = base`) in the sync path; this primitive is for service writes
       * that already hold the row.
       */
      const update = (reminder: Reminder) =>
        Effect.map(
          updateStatement<ReminderRow>(sql, REMINDER_TABLE, {
            id: reminder.id,
            values: reminderValues(reminder),
            returning: REMINDER_SELECT,
          }),
          rows => Option.map(Option.fromUndefinedOr(rows[0]), toReminder),
        )

      return {
        findById,
        findOccasionByFireAt,
        listOccasionLinkedInRange,
        listVisible,
        insert,
        update,
      }
    }),
  },
) {}

export const ReminderRepoLive = Layer.effect(ReminderRepo, ReminderRepo.make)

/**
 * The dispatch ledger (ADR-0005). Server-written only: clients cannot forge a
 * dispatch through sync, and the inbox/response routes are the only readers of
 * another member's ledger rows.
 */
export class ReminderDispatchRepo extends Context.Service<ReminderDispatchRepo>()(
  'ReminderDispatchRepo',
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const findById = (id: ReminderDispatchId) =>
        Effect.map(
          sql<ReminderDispatchRow>`
            SELECT ${sql.literal(REMINDER_DISPATCH_SELECT)}
            FROM reminder_dispatches WHERE id = ${id}
          `,
          rows =>
            Option.map(Option.fromUndefinedOr(rows[0]), toReminderDispatch),
        )

      /**
       * The sweep's due read (ADR-0005 §2): live reminders whose next fire is at
       * or before the tick, with the owner's display zone for the policy.
       *
       * The `NOT EXISTS` rides the unique ledger key `(reminder_id,
       * scheduled_for, origin)`, so a tick that already claimed this fire sees
       * nothing — the claim itself is still the mutex; this only avoids
       * re-reading the same rows every minute.
       */
      const listDueFires = (input: {
        readonly now: string
        readonly limit: number
      }) =>
        Effect.map(
          sql<{
            readonly reminderId: string
            readonly fireAt: string
            readonly ownerId: string
            readonly ownerTimeZone: string
            readonly tier: string
            readonly repeat: string
            readonly timeZone: string
            readonly silencedUntil: string | null
          }>`
            SELECT r.id AS reminderId, r.fire_at AS fireAt, r.owner_id AS ownerId,
                   COALESCE(p.time_zone, u.time_zone, 'UTC') AS ownerTimeZone,
                   r.tier AS tier, r.repeat AS repeat, r.time_zone AS timeZone,
                   r.silenced_until AS silencedUntil
            FROM reminders r
            LEFT JOIN user_preferences p ON p.user_id = r.owner_id
            LEFT JOIN users u ON u.id = r.owner_id
            WHERE r.fire_at <= ${input.now}
              AND r.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM reminder_dispatches d
                WHERE d.reminder_id = r.id
                  AND d.scheduled_for = r.fire_at
                  AND d.origin = 'schedule'
              )
            ORDER BY r.fire_at ASC
            LIMIT ${input.limit}
          `,
          rows =>
            rows.map(row => ({
              reminderId: row.reminderId,
              fireAt: row.fireAt,
              ownerId: row.ownerId,
              ownerTimeZone: row.ownerTimeZone,
              tier: row.tier as ReminderTier,
              repeat: repeatOf(row.repeat),
              timeZone: row.timeZone,
              silencedUntil: row.silencedUntil,
            })),
        )

      // TODO(cutover): near-duplicates `listOwed` below — the pilot's fresh-facts seam; goes with the old D1 sweep path.
      /**
       * The tick's owed-facts read (ADR-0005 §2): every unanswered,
       * still-retryable dispatch with the reminder words its push shows and
       * the two facts that close a row without pushing — a live silence or a
       * deletion. The model vouches per dispatch id, so a projection row not
       * yet visible simply holds until the next tick.
       */
      const listOwedFacts = (input: {
        readonly now: string
        readonly limit: number
      }) =>
        Effect.map(
          sql<{
            readonly dispatchId: ReminderDispatchId
            readonly ownerId: string
            readonly title: string
            readonly note: string | null
            readonly kind: ReminderType
            readonly tier: ReminderTier
            readonly silencedUntil: string | null
            readonly deletedAt: string | null
          }>`
            SELECT d.id AS dispatchId, d.user_id AS ownerId,
                   r.title, r.note AS note, r.kind AS kind, r.tier AS tier,
                   r.silenced_until AS silencedUntil, r.deleted_at AS deletedAt
            FROM reminder_dispatches d
            JOIN reminders r ON r.id = d.reminder_id
            WHERE d.response IS NULL
              AND d.push_outcome IN ('pending', 'failed')
            ORDER BY d.deliver_at ASC
            LIMIT ${input.limit}
          `,
          rows => rows,
        )

      /**
       * The sweep's owed read (ADR-0005 §2): claimed but unanswered rows whose
       * deliver-at has arrived and that are still retryable. Joined to the
       * reminder so one read gives the push payload without an N+1.
       */
      const listOwed = (input: {
        readonly now: string
        readonly limit: number
      }) =>
        Effect.map(
          sql<
            ReminderDispatchRow & {
              readonly rTitle: string
              readonly rNote: string | null
              readonly rKind: string
              readonly rTier: string
            }
          >`
            SELECT ${sql.literal(dispatchColumns('d.'))},
                   r.title AS rTitle, r.note AS rNote, r.kind AS rKind, r.tier AS rTier
            FROM reminder_dispatches d
            JOIN reminders r ON r.id = d.reminder_id
            WHERE d.response IS NULL
              AND d.push_outcome IN ('pending', 'failed')
              AND d.deliver_at <= ${input.now}
              AND r.deleted_at IS NULL
            ORDER BY d.deliver_at ASC
            LIMIT ${input.limit}
          `,
          rows =>
            rows.map(row => ({
              dispatch: toReminderDispatch(row),
              title: row.rTitle,
              note: row.rNote,
              kind: row.rKind as ReminderType,
              tier: row.rTier as ReminderTier,
            })),
        )

      /**
       * Publish one push result (ADR-0005 §3): the outcome cannot share the
       * claim batch because it is only known after the `fetch`. Gated on the
       * row still being unanswered so an answer that landed mid-tick wins.
       */
      const outcomeStatement = (input: {
        readonly dispatchId: ReminderDispatchId
        readonly pushOutcome: PushOutcome
        readonly attempts: number
        readonly lastAttemptAt: string | null
      }): Statement.Statement<unknown> =>
        sql`
          UPDATE reminder_dispatches SET
            push_outcome = ${input.pushOutcome},
            attempts = ${input.attempts},
            last_attempt_at = ${input.lastAttemptAt}
          WHERE id = ${input.dispatchId} AND response IS NULL
        `

      /**
       * Take the send slot for one dispatch (ticket #61's answered-mid-tick
       * guard).
       *
       * The owed read is a snapshot; the owner can answer between that read and
       * the push. This compare-and-set is the last look at the dispatch's own
       * state before `fetch`: it increments the attempt count only while the row
       * is still unanswered and retryable, and returns false otherwise. The
       * caller must not send when it is false. The remaining window is the
       * in-flight POST itself (one `fetch`), which no ledger write can cancel;
       * the outcome update is already gated on `response IS NULL`, so the answer
       * can never be overwritten or reopened by that late push.
       */
      const takeAttempts = (input: {
        readonly dispatchIds: ReadonlyArray<ReminderDispatchId>
        readonly now: string
      }) =>
        input.dispatchIds.length === 0
          ? Effect.succeed([] as ReadonlyArray<string>)
          : Effect.map(
              sql<{ readonly id: string }>`
              UPDATE reminder_dispatches
              SET attempts = attempts + 1, last_attempt_at = ${input.now}
              WHERE ${sql.in('id', input.dispatchIds)}
                AND response IS NULL
                AND push_outcome IN ('pending', 'failed')
              RETURNING id
            `,
              rows => rows.map(row => row.id),
            )

      /** The at-most-one snooze child of a parent dispatch. */
      const findSnoozeChild = (parentDispatchId: ReminderDispatchId) =>
        Effect.map(
          sql<ReminderDispatchRow>`
            SELECT ${sql.literal(REMINDER_DISPATCH_SELECT)}
            FROM reminder_dispatches WHERE parent_dispatch_id = ${parentDispatchId}
          `,
          rows =>
            Option.map(Option.fromUndefinedOr(rows[0]), toReminderDispatch),
        )

      /**
       * One owner's unanswered dispatches.
       *
       * Inbox = unanswered, `scheduled_for < now`, younger than 24 h.
       * History = everything else (answered, upcoming, or aged past 24 h) —
       * the rows are never deleted, only moved out of the inbox view.
       */
      const listInbox = (input: {
        readonly userId: UserId
        readonly now: string
        readonly history?: boolean
        readonly limit?: number
      }) =>
        Effect.gen(function* () {
          const limit = input.limit ?? 100
          const cutoff = new Date(
            Date.parse(input.now) - 24 * 60 * 60 * 1000,
          ).toISOString()
          const rows =
            input.history === true
              ? yield* sql<
                  ReminderDispatchRow & {
                    readonly rTitle: string
                    readonly rNote: string | null
                    readonly rKind: string
                    readonly rTier: string
                    readonly rLinkType: string
                    readonly rLinkId: string | null
                    readonly rVisibility: string
                  }
                >`
              SELECT ${sql.literal(dispatchColumns('d.'))},
                     r.title AS rTitle, r.note AS rNote, r.kind AS rKind, r.tier AS rTier,
                     r.link_type AS rLinkType, r.link_id AS rLinkId,
                     r.visibility AS rVisibility
              FROM reminder_dispatches d
              JOIN reminders r ON r.id = d.reminder_id
              WHERE d.user_id = ${input.userId}
                AND (d.response IS NOT NULL OR d.scheduled_for < ${cutoff})
              ORDER BY d.scheduled_for DESC
              LIMIT ${limit}
            `
              : yield* sql<
                  ReminderDispatchRow & {
                    readonly rTitle: string
                    readonly rNote: string | null
                    readonly rKind: string
                    readonly rTier: string
                    readonly rLinkType: string
                    readonly rLinkId: string | null
                    readonly rVisibility: string
                  }
                >`
              SELECT ${sql.literal(dispatchColumns('d.'))},
                     r.title AS rTitle, r.note AS rNote, r.kind AS rKind, r.tier AS rTier,
                     r.link_type AS rLinkType, r.link_id AS rLinkId,
                     r.visibility AS rVisibility
              FROM reminder_dispatches d
              JOIN reminders r ON r.id = d.reminder_id
              WHERE d.user_id = ${input.userId}
                AND d.response IS NULL
                AND d.scheduled_for < ${input.now}
                AND d.scheduled_for >= ${cutoff}
              ORDER BY d.scheduled_for ASC
              LIMIT ${limit}
            `
          return rows.map((row): ReminderInboxItem => ({
            dispatch: toReminderDispatch(row),
            reminderId: row.reminderId as ReminderId,
            title: row.rTitle,
            note: row.rNote,
            kind: row.rKind as ReminderType,
            tier: row.rTier as ReminderTier,
            link: decodeReminderLink(row.rLinkType, row.rLinkId),
            visibility:
              row.rVisibility === 'private' || row.rVisibility === 'shared'
                ? row.rVisibility
                : defaultVisibilityFor('reminder'),
            state: input.history === true ? 'history' : 'inbox',
          }))
        })

      const insert = (dispatch: ReminderDispatch) =>
        Effect.map(
          sql<ReminderDispatchRow>`
            INSERT INTO reminder_dispatches
              (id, reminder_id, user_id, scheduled_for, deliver_at, root_scheduled_for,
               origin, push_outcome, attempts, last_attempt_at, parent_dispatch_id,
               response, responded_at, snoozed_until, created_at)
            VALUES
              (${dispatch.id}, ${dispatch.reminderId}, ${dispatch.userId},
               ${dispatch.scheduledFor}, ${dispatch.deliverAt}, ${dispatch.rootScheduledFor},
               ${dispatch.origin}, ${dispatch.pushOutcome}, ${dispatch.attempts},
               ${dispatch.lastAttemptAt}, ${dispatch.parentDispatchId}, ${dispatch.response},
               ${dispatch.respondedAt}, ${dispatch.snoozedUntil}, ${dispatch.createdAt})
            RETURNING ${sql.literal(REMINDER_DISPATCH_SELECT)}
          `,
          rows => toReminderDispatch(rows[0]!),
        )

      /**
       * The answer CAS: only an unanswered row can be answered, so a double
       * tap writes nothing and returns the stored answer.
       */
      const respondStatement = (input: {
        readonly dispatchId: ReminderDispatchId
        readonly response: DispatchResponse
        readonly respondedAt: string
        readonly snoozedUntil: string | null
      }): Statement.Statement<unknown> =>
        sql`
          UPDATE reminder_dispatches SET
            response = ${input.response},
            responded_at = ${input.respondedAt},
            snoozed_until = ${input.snoozedUntil}
          WHERE id = ${input.dispatchId} AND response IS NULL
        `

      /**
       * The snooze child, in the same batch as the parent answer.
       *
       * Gated on the parent actually carrying this snooze answer, and protected
       * by the partial unique index on `parent_dispatch_id`, so a double tap
       * or an overlapping retry produces exactly one child.
       */
      const insertSnoozeChildStatement = (
        child: ReminderDispatch,
      ): Statement.Statement<unknown> =>
        sql`
          INSERT INTO reminder_dispatches
            (id, reminder_id, user_id, scheduled_for, deliver_at, root_scheduled_for,
             origin, push_outcome, attempts, last_attempt_at, parent_dispatch_id,
             response, responded_at, snoozed_until, created_at)
          SELECT
            ${child.id}, ${child.reminderId}, ${child.userId},
            ${child.scheduledFor}, ${child.deliverAt}, ${child.rootScheduledFor},
            ${child.origin}, 'pending', 0, NULL, ${child.parentDispatchId},
            NULL, NULL, NULL, ${child.createdAt}
          WHERE EXISTS (
            SELECT 1 FROM reminder_dispatches
            WHERE id = ${child.parentDispatchId}
              AND response = 'snooze'
              AND responded_at = ${child.createdAt}
          )
          ON CONFLICT DO NOTHING
        `

      /**
       * Expire every owed row of a reminder (silence or delete, ADR-0005 §5).
       * The row stays in the ledger as `expired`, inbox-only.
       */
      const expireOwedStatement = (
        reminderId: ReminderId,
      ): Statement.Statement<unknown> =>
        sql`
          UPDATE reminder_dispatches SET push_outcome = 'expired'
          WHERE reminder_id = ${reminderId}
            AND response IS NULL
            AND push_outcome IN ('pending', 'failed')
        `

      /**
       * The claim INSERT (ADR-0005 §3).
       *
       * It only lands while the reminder is live and still holds the exact
       * `fire_at` this claim is for — a stale tick whose series already moved
       * cannot write a row. The unique key
       * `(reminder_id, scheduled_for, origin)` is the mutex for overlapping
       * ticks, so the loser writes nothing.
       */
      const claimInsertStatement = (
        dispatch: ReminderDispatch,
      ): Statement.Statement<unknown> =>
        sql`
          INSERT INTO reminder_dispatches
            (id, reminder_id, user_id, scheduled_for, deliver_at, root_scheduled_for,
             origin, push_outcome, attempts, last_attempt_at, parent_dispatch_id,
             response, responded_at, snoozed_until, created_at)
          SELECT
            ${dispatch.id}, ${dispatch.reminderId}, ${dispatch.userId},
            ${dispatch.scheduledFor}, ${dispatch.deliverAt}, ${dispatch.rootScheduledFor},
            ${dispatch.origin}, 'pending', 0, NULL, NULL, NULL, NULL, NULL,
            ${dispatch.createdAt}
          WHERE EXISTS (
            SELECT 1 FROM reminders
            WHERE id = ${dispatch.reminderId}
              AND fire_at = ${dispatch.scheduledFor}
              AND deleted_at IS NULL
          )
          ON CONFLICT DO NOTHING
        `

      /**
       * The series advance, gated on the claim INSERT above landing
       * (`changes() = 1`). This is the CAS that stops a tick which lost the
       * unique race from also moving the schedule.
       */
      const advanceFireAtStatement = (input: {
        readonly reminderId: ReminderId
        readonly from: string
        readonly to: string
      }): Statement.Statement<unknown> =>
        sql`
          UPDATE reminders SET fire_at = ${input.to}
          WHERE id = ${input.reminderId}
            AND fire_at = ${input.from}
            AND changes() = 1
        `

      /**
       * A suppress is not a write to the ledger: the series simply advances
       * past the silence (ADR-0005 §5). Gated on the fire instant we saw, so
       * two ticks converge on one advance.
       */
      const advanceSuppressedStatement = (input: {
        readonly reminderId: ReminderId
        readonly from: string
        readonly to: string
      }): Statement.Statement<unknown> =>
        sql`
          UPDATE reminders SET fire_at = ${input.to}
          WHERE id = ${input.reminderId}
            AND fire_at = ${input.from}
            AND deleted_at IS NULL
        `

      return {
        findById,
        findSnoozeChild,
        listInbox,
        listDueFires,
        listOwed,
        listOwedFacts,
        outcomeStatement,
        takeAttempts,
        insert,
        respondStatement,
        insertSnoozeChildStatement,
        expireOwedStatement,
        claimInsertStatement,
        advanceFireAtStatement,
        advanceSuppressedStatement,
      }
    }),
  },
) {}

export const ReminderDispatchRepoLive = Layer.effect(
  ReminderDispatchRepo,
  ReminderDispatchRepo.make,
)
