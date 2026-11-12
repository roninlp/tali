import { Schema } from 'effect'
import { EventId, HabitId, OccasionId, TaskId } from './common.js'

/**
 * The discriminated link a reminder hangs off (docs/domain-model-draft.md
 * §3.6; settled in #7 as "discriminated union, not nullable FKs").
 *
 * ## Why a union and not nullable foreign keys
 *
 * Nullable FKs (`habitId?`, `taskId?`, `eventId?`) allow the invalid state
 * "linked to two things at once", and every reader has to decide what a row
 * with two ids means. The union makes the link exactly one of: nothing, a
 * habit, a task or an event — so "the reminder fires → mark the linked thing
 * done" (FR-REM-03) is a pattern match, not a pile of null checks.
 *
 * ## Why it lives here
 *
 * The union is defined by the **event** slice (ticket #57) because the event
 * is the first aggregate that needs it: the `event` variant carries the
 * `EventId` brand. The reminder aggregate (#60) consumes the union as-is, so
 * the reminder slice needs no migration and no redefinition.
 *
 * ## The `occasion` variant (#59)
 *
 * An occasion's advance reminder ("seven days before the birthday") is a
 * reminder *about the occasion*, not about an event created from it: the
 * occurrence is projected, so there is no event row to point at. The variant is
 * therefore part of the union from the occasions slice, and the advance
 * reminder's fire instant is computed by `occasion-projection.ts`. #60
 * materialises the reminder row; it never needs a second link type.
 */
export const ReminderLink = Schema.Union([
  Schema.TaggedStruct('none', {}),
  Schema.TaggedStruct('habit', { habitId: HabitId }),
  Schema.TaggedStruct('task', { taskId: TaskId }),
  Schema.TaggedStruct('event', { eventId: EventId }),
  Schema.TaggedStruct('occasion', { occasionId: OccasionId }),
])
export type ReminderLink = Schema.Schema.Type<typeof ReminderLink>

/** A reminder that is not linked to another item. */
export const noReminderLink = (): ReminderLink => ({ _tag: 'none' })

/** A reminder that completes the linked habit. */
export const habitReminderLink = (habitId: HabitId): ReminderLink => ({
  _tag: 'habit',
  habitId,
})

/** A reminder that completes the linked task. */
export const taskReminderLink = (taskId: TaskId): ReminderLink => ({
  _tag: 'task',
  taskId,
})

/** A reminder that applies to the linked event. */
export const eventReminderLink = (eventId: EventId): ReminderLink => ({
  _tag: 'event',
  eventId,
})

/** A reminder about an occasion's projected occurrence. */
export const occasionReminderLink = (occasionId: OccasionId): ReminderLink => ({
  _tag: 'occasion',
  occasionId,
})

/**
 * The flattened `(link_type, link_id)` column pair.
 *
 * Storage is two columns rather than nullable foreign keys so "linked to two
 * things" is not representable (see the union's note above). `linkId` is null
 * exactly when `linkType` is `none`.
 */
export interface ReminderLinkColumns {
  readonly linkType: 'none' | 'task' | 'event' | 'habit' | 'occasion'
  readonly linkId: string | null
}

/**
 * Flatten the union for the `(link_type, link_id)` columns.
 *
 * The `switch` is deliberately exhaustive with no `default`: adding a sixth
 * variant is a compile error here, so no persistence path can silently store a
 * new link as `none`.
 */
export const encodeReminderLink = (link: ReminderLink): ReminderLinkColumns => {
  switch (link._tag) {
    case 'none':
      return { linkType: 'none', linkId: null }
    case 'habit':
      return { linkType: 'habit', linkId: link.habitId }
    case 'task':
      return { linkType: 'task', linkId: link.taskId }
    case 'event':
      return { linkType: 'event', linkId: link.eventId }
    case 'occasion':
      return { linkType: 'occasion', linkId: link.occasionId }
  }
}

/**
 * Rebuild the union from stored columns.
 *
 * An unknown type or a known type with a null id is `none`: the malformed-row
 * fallback every SQL reader needs, because a row can outlive a variant or be
 * written by an older build. The id is branded with `.make` like every other
 * persistence read, so a non-UUID cell still fails loudly; a `none` row never
 * touches the brand.
 */
export const decodeReminderLink = (
  linkType: string,
  linkId: string | null,
): ReminderLink => {
  switch (linkType) {
    case 'habit':
      return linkId === null
        ? noReminderLink()
        : habitReminderLink(HabitId.make(linkId))
    case 'task':
      return linkId === null
        ? noReminderLink()
        : taskReminderLink(TaskId.make(linkId))
    case 'event':
      return linkId === null
        ? noReminderLink()
        : eventReminderLink(EventId.make(linkId))
    case 'occasion':
      return linkId === null
        ? noReminderLink()
        : occasionReminderLink(OccasionId.make(linkId))
    default:
      return noReminderLink()
  }
}
