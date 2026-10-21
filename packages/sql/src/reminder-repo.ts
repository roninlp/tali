import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  type DispatchResponse,
  type HouseholdId,
  type PushOutcome,
  Reminder,
  ReminderDispatch,
  type ReminderDispatchId,
  type ReminderId,
  type ReminderInboxItem,
  type ReminderRepeat,
  type ReminderTier,
  type ReminderType,
  type UserId,
  type Visibility
} from "@tali/domain"
import { ReminderLink } from "@tali/domain"

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

/** The trusted column projection, aliased to the camelCase wire names. */
export const REMINDER_SELECT =
  `id, type, title, note, owner_id AS ownerId, household_id AS householdId, visibility, color, ` +
  `kind, tier, repeat, offset_minutes AS offsetMinutes, fire_at AS fireAt, ` +
  `link_type AS linkType, link_id AS linkId, silenced_until AS silencedUntil, ` +
  `time_zone AS timeZone, created_at AS createdAt, updated_at AS updatedAt, ` +
  `version, deleted_at AS deletedAt`

const dispatchColumns = (prefix: string): string =>
  `${prefix}id, ${prefix}reminder_id AS reminderId, ${prefix}user_id AS userId, ` +
  `${prefix}scheduled_for AS scheduledFor, ${prefix}deliver_at AS deliverAt, ` +
  `${prefix}root_scheduled_for AS rootScheduledFor, ${prefix}origin, ` +
  `${prefix}push_outcome AS pushOutcome, ${prefix}attempts, ` +
  `${prefix}last_attempt_at AS lastAttemptAt, ${prefix}parent_dispatch_id AS parentDispatchId, ` +
  `${prefix}response, ${prefix}responded_at AS respondedAt, ` +
  `${prefix}snoozed_until AS snoozedUntil, ${prefix}created_at AS createdAt`

export const REMINDER_DISPATCH_SELECT = dispatchColumns("")

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

const parseJson = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** A row's repeat union; a malformed cell falls back to a one-off. */
const repeatOf = (value: string): ReminderRepeat => {
  const parsed = parseJson(value)
  if (typeof parsed === "object" && parsed !== null && "_tag" in parsed) {
    return parsed as ReminderRepeat
  }
  return { _tag: "once" }
}

/** A row's link union from the flattened columns. */
const linkOf = (type: string, id: string | null): ReminderLink => {
  switch (type) {
    case "task":
      return id === null ? { _tag: "none" } : { _tag: "task", taskId: id as never }
    case "event":
      return id === null ? { _tag: "none" } : { _tag: "event", eventId: id as never }
    case "habit":
      return id === null ? { _tag: "none" } : { _tag: "habit", habitId: id as never }
    case "occasion":
      return id === null ? { _tag: "none" } : { _tag: "occasion", occasionId: id as never }
    default:
      return { _tag: "none" }
  }
}

/** The model's plain shape, built from a D1 row. */
export const reminderPropsOf = (row: ReminderRow) => ({
  id: row.id as Reminder["id"],
  type: "reminder" as const,
  title: row.title,
  note: row.note,
  kind: row.kind as ReminderType,
  tier: row.tier as ReminderTier,
  repeat: repeatOf(row.repeat),
  fireAt: row.fireAt,
  offsetMinutes: Number(row.offsetMinutes),
  link: linkOf(row.linkType, row.linkId),
  silencedUntil: row.silencedUntil,
  timeZone: row.timeZone,
  ownerId: row.ownerId as UserId,
  householdId: row.householdId as HouseholdId,
  visibility: row.visibility as Visibility,
  color: row.color,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: Number(row.version),
  deletedAt: row.deletedAt
})

export const toReminder = (row: ReminderRow): Reminder => new Reminder(reminderPropsOf(row))

export const dispatchPropsOf = (row: ReminderDispatchRow) => ({
  id: row.id as ReminderDispatch["id"],
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
  createdAt: row.createdAt
})

export const toReminderDispatch = (row: ReminderDispatchRow): ReminderDispatch =>
  new ReminderDispatch(dispatchPropsOf(row))

/** Flatten a link union for the two columns. */
export const linkColumns = (
  link: ReminderLink
): { readonly linkType: string; readonly linkId: string | null } => {
  switch (link._tag) {
    case "task":
      return { linkType: "task", linkId: link.taskId }
    case "event":
      return { linkType: "event", linkId: link.eventId }
    case "habit":
      return { linkType: "habit", linkId: link.habitId }
    case "occasion":
      return { linkType: "occasion", linkId: link.occasionId }
    default:
      return { linkType: "none", linkId: null }
  }
}

const encodeRepeat = (repeat: ReminderRepeat): string => JSON.stringify(repeat)

export class ReminderRepo extends Context.Service<ReminderRepo>()("ReminderRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every reminder read shares (private owner-only). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

    const findById = (id: ReminderId) =>
      Effect.map(
        sql<ReminderRow>`SELECT ${sql.literal(REMINDER_SELECT)} FROM reminders WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toReminder)
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
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toReminder)
      )

    /** Live rows visible to one member: shared reminders plus their own private ones. */
    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
      readonly includeDeleted?: boolean
    }) =>
      Effect.map(
        sql<ReminderRow>`
          SELECT ${sql.literal(REMINDER_SELECT)} FROM reminders
          WHERE ${visibleScope(input)}
            ${input.includeDeleted === true ? sql`` : sql`AND deleted_at IS NULL`}
          ORDER BY fire_at ASC, id ASC
        `,
        (rows) => rows.map(toReminder)
      )

    const insert = (reminder: Reminder) => {
      const link = linkColumns(reminder.link)
      return Effect.map(
        sql<ReminderRow>`
          INSERT INTO reminders
            (id, type, title, note, owner_id, household_id, visibility, color,
             kind, tier, repeat, offset_minutes, fire_at, link_type, link_id,
             silenced_until, time_zone, created_at, updated_at, version, deleted_at)
          VALUES
            (${reminder.id}, ${reminder.type}, ${reminder.title}, ${reminder.note},
             ${reminder.ownerId}, ${reminder.householdId}, ${reminder.visibility},
             ${reminder.color}, ${reminder.kind}, ${reminder.tier},
             ${encodeRepeat(reminder.repeat)}, ${reminder.offsetMinutes},
             ${reminder.fireAt}, ${link.linkType}, ${link.linkId},
             ${reminder.silencedUntil}, ${reminder.timeZone}, ${reminder.createdAt},
             ${reminder.updatedAt}, ${reminder.version}, ${reminder.deletedAt})
          RETURNING ${sql.literal(REMINDER_SELECT)}
        `,
        (rows) => toReminder(rows[0]!)
      )
    }

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (reminder: Reminder) => {
      const link = linkColumns(reminder.link)
      return Effect.map(
        sql<ReminderRow>`
          UPDATE reminders SET
            title = ${reminder.title},
            note = ${reminder.note},
            visibility = ${reminder.visibility},
            color = ${reminder.color},
            kind = ${reminder.kind},
            tier = ${reminder.tier},
            repeat = ${encodeRepeat(reminder.repeat)},
            offset_minutes = ${reminder.offsetMinutes},
            fire_at = ${reminder.fireAt},
            link_type = ${link.linkType},
            link_id = ${link.linkId},
            silenced_until = ${reminder.silencedUntil},
            time_zone = ${reminder.timeZone},
            updated_at = ${reminder.updatedAt},
            version = ${reminder.version},
            deleted_at = ${reminder.deletedAt}
          WHERE id = ${reminder.id}
          RETURNING ${sql.literal(REMINDER_SELECT)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toReminder)
      )
    }

    return { findById, findOccasionByFireAt, listVisible, insert, update } as const
  })
}) {}

export const ReminderRepoLive = Layer.effect(ReminderRepo, ReminderRepo.make)

/**
 * The dispatch ledger (ADR-0005). Server-written only: clients cannot forge a
 * dispatch through sync, and the inbox/response routes are the only readers of
 * another member's ledger rows.
 */
export class ReminderDispatchRepo extends Context.Service<ReminderDispatchRepo>()(
  "ReminderDispatchRepo",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findById = (id: ReminderDispatchId) =>
        Effect.map(
          sql<ReminderDispatchRow>`
            SELECT ${sql.literal(REMINDER_DISPATCH_SELECT)}
            FROM reminder_dispatches WHERE id = ${id}
          `,
          (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toReminderDispatch)
        )

      /** The at-most-one snooze child of a parent dispatch. */
      const findSnoozeChild = (parentDispatchId: ReminderDispatchId) =>
        Effect.map(
          sql<ReminderDispatchRow>`
            SELECT ${sql.literal(REMINDER_DISPATCH_SELECT)}
            FROM reminder_dispatches WHERE parent_dispatch_id = ${parentDispatchId}
          `,
          (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toReminderDispatch)
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
        Effect.gen(function*() {
          const limit = input.limit ?? 100
          const cutoff = new Date(Date.parse(input.now) - 24 * 60 * 60 * 1000).toISOString()
          const rows = input.history === true
            ? yield* sql<ReminderDispatchRow & {
              readonly rTitle: string
              readonly rKind: string
              readonly rTier: string
              readonly rLinkType: string
              readonly rLinkId: string | null
            }>`
              SELECT ${sql.literal(dispatchColumns("d."))},
                     r.title AS rTitle, r.kind AS rKind, r.tier AS rTier,
                     r.link_type AS rLinkType, r.link_id AS rLinkId
              FROM reminder_dispatches d
              JOIN reminders r ON r.id = d.reminder_id
              WHERE d.user_id = ${input.userId}
                AND (d.response IS NOT NULL OR d.scheduled_for < ${cutoff})
              ORDER BY d.scheduled_for DESC
              LIMIT ${limit}
            `
            : yield* sql<ReminderDispatchRow & {
              readonly rTitle: string
              readonly rKind: string
              readonly rTier: string
              readonly rLinkType: string
              readonly rLinkId: string | null
            }>`
              SELECT ${sql.literal(dispatchColumns("d."))},
                     r.title AS rTitle, r.kind AS rKind, r.tier AS rTier,
                     r.link_type AS rLinkType, r.link_id AS rLinkId
              FROM reminder_dispatches d
              JOIN reminders r ON r.id = d.reminder_id
              WHERE d.user_id = ${input.userId}
                AND d.response IS NULL
                AND d.scheduled_for < ${input.now}
                AND d.scheduled_for >= ${cutoff}
              ORDER BY d.scheduled_for ASC
              LIMIT ${limit}
            `
          return rows.map(
            (row): ReminderInboxItem => ({
              dispatch: toReminderDispatch(row),
              reminderId: row.reminderId as ReminderId,
              title: row.rTitle,
              kind: row.rKind as ReminderType,
              tier: row.rTier as ReminderTier,
              link: linkOf(row.rLinkType, row.rLinkId),
              state: input.history === true ? "history" : "inbox"
            })
          )
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
          (rows) => toReminderDispatch(rows[0]!)
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
        child: ReminderDispatch
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
      const expireOwedStatement = (reminderId: ReminderId): Statement.Statement<unknown> =>
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
      const claimInsertStatement = (dispatch: ReminderDispatch): Statement.Statement<unknown> =>
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
        insert,
        respondStatement,
        insertSnoozeChildStatement,
        expireOwedStatement,
        claimInsertStatement,
        advanceFireAtStatement,
        advanceSuppressedStatement
      } as const
    })
  }
) {}

export const ReminderDispatchRepoLive = Layer.effect(
  ReminderDispatchRepo,
  ReminderDispatchRepo.make
)
