import { Schema } from 'effect'
import { UserId } from '@tali/domain'

/**
 * The reminder-firing aggregate's id: one instance per **owner**.
 *
 * ADR-0005 §8 settles "one sweep for both users; no per-household object" —
 * isolation is a `WHERE`, not an instance. The firing model keeps the same
 * shape one level up: every dispatch of one owner is decided inside that
 * owner's single instance, so the claim mutex, the snooze child rule and the
 * "answer beats the push" guard are one-object invariants rather than
 * compare-and-set dances. A second household costs a second pair of owner
 * instances, not new machinery.
 */
export const ReminderOwnerId = UserId
export type ReminderOwnerId = Schema.Schema.Type<typeof ReminderOwnerId>
