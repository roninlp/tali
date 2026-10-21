import {
  Event,
  deleteEventOccurrence,
  overrideEventOccurrence,
  patchEventSeries,
  splitEventSeries,
  truncateEventSeries,
  uuidV7,
  type EventEditScope,
  type EventExceptionOverrides,
  type EventId,
  type LocalDate
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"
import { eventSourceFromMirror } from "./model"

/**
 * The event edit-scope choice (ticket #62; FR-CAL-03, ADR-0004).
 *
 * #58 built the split semantics in the pure domain layer and the service:
 *
 * - **this occurrence** — one `override` exception on the same series row;
 * - **this and following** — the series splits: the old row is truncated the
 *   day before the occurrence and a new row starts at it (at the series' first
 *   occurrence the split has nothing before it, so it is a whole-series edit).
 *
 * This module is the calendar's write path for that choice. It calls the same
 * pure functions, then commits the resulting rows to the local mirror and the
 * outbox in one transaction, so an edit works offline and travels on the next
 * `/sync/push` exactly like every other local-first write. The service path
 * (`EditEventOccurrence`) remains the server-authoritative alternative; the
 * rows this module writes are the same rows that path would produce.
 *
 * A split is **two rows**, written in the order "truncate, then start the
 * tail". If the second write fails, the first is already durable and the tail
 * is missing; the caller reports the failure and the pending truncation still
 * travels, so the next edit can retry from the (now shorter) series. Writing
 * the tail first would leave two live halves, which is the one outcome the
 * read models cannot reconcile.
 */

/** The rows a scoped edit or delete produces. */
export interface EventScopeChange {
  readonly series: Event
  /** The new tail row for a split; `null` for every other scope. */
  readonly following: Event | null
}

export interface EventScopeInput {
  readonly event: Event
  /** The occurrence key: its local start date in the event's own zone. */
  readonly instanceId: string
  readonly exceptionId: string
  /** The client-minted id for the split's new series row. */
  readonly followingId: string
  readonly now: string
}

const isTombstoned = (event: Event): boolean => event.deletedAt !== null

/**
 * "This occurrence" / "this and following" **edit**.
 *
 * Mirrors `EventService.editOccurrence` step for step, including the two
 * degenerate cases: a one-off event (its occurrence *is* the event) and a split
 * at the first occurrence (which is a whole-series edit).
 */
export const editEventWithinScope = (
  input: EventScopeInput & {
    readonly overrides: EventExceptionOverrides
    readonly scope: EventEditScope
  }
): EventScopeChange => {
  const { event, instanceId, overrides, scope } = input
  if (event.recurrence === null) {
    return { series: patchEventSeries(event, overrides, input.now), following: null }
  }

  if (scope === "thisAndFollowing") {
    const split = splitEventSeries({
      event,
      instanceId,
      overrides,
      followingId: input.followingId,
      now: input.now
    })
    if (split !== null) return { series: split.previous, following: split.following }
    // Nothing precedes the first occurrence: the whole series takes the edit.
    return { series: patchEventSeries(event, overrides, input.now), following: null }
  }

  return {
    series: overrideEventOccurrence({
      event,
      instanceId: instanceId as LocalDate,
      overrides,
      exceptionId: input.exceptionId,
      now: input.now
    }),
    following: null
  }
}

/** "This occurrence" / "this and following" **delete**. */
export const deleteEventWithinScope = (
  input: EventScopeInput & { readonly scope: EventEditScope }
): EventScopeChange => {
  const { event, instanceId, scope } = input
  if (event.recurrence === null) {
    return { series: truncateEventSeries({ event, instanceId, now: input.now }), following: null }
  }
  if (scope === "thisAndFollowing") {
    return {
      series: truncateEventSeries({ event, instanceId, now: input.now }),
      following: null
    }
  }
  return {
    series: deleteEventOccurrence({
      event,
      instanceId: instanceId as LocalDate,
      exceptionId: input.exceptionId,
      now: input.now
    }),
    following: null
  }
}

/**
 * The writable fields of a row. The common-item scope (owner, household) is
 * deliberately absent: the server resolves it from the session, and a local
 * row created offline does not know it yet.
 */
const eventWritePatch = (event: Event): Record<string, unknown> => ({
  title: event.title,
  description: event.description,
  location: event.location,
  category: event.category,
  color: event.color,
  people: event.people,
  timing: event.timing,
  timeZone: event.timeZone,
  recurrence: event.recurrence,
  exceptions: event.exceptions,
  occasionId: event.occasionId,
  visibility: event.visibility
})

/**
 * Commit a scoped change to the mirror + outbox.
 *
 * The series row is written first: for a split it is the truncation the tail
 * depends on, and for a delete it is the tombstone. `now` is shared so both
 * rows of a split carry the same mutation time.
 */
export const applyEventScopeInMirror = async (
  store: LocalStore,
  change: EventScopeChange,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({
    entityType: "event",
    entityId: change.series.id,
    op: isTombstoned(change.series) ? "delete" : "upsert",
    patch: eventWritePatch(change.series),
    now
  })
  if (change.following === null) return
  await store.writeLocal({
    entityType: "event",
    entityId: change.following.id,
    op: "upsert",
    patch: {
      id: change.following.id,
      type: "event",
      createdAt: change.following.createdAt,
      ...eventWritePatch(change.following)
    },
    now
  })
}

/** A fresh exception id / split id for one scoped action. */
export const newScopedIds = (): {
  readonly exceptionId: string
  readonly followingId: string
} => ({ exceptionId: uuidV7(), followingId: uuidV7() })

/**
 * Hydrate a mirrored event row into the aggregate the pure functions take.
 *
 * The mirror holds whatever the last sync/ack wrote; a local row created
 * offline has no owner/household yet, so the caller supplies the session's ids
 * as fallbacks. They are never written back (see `eventWritePatch`). A row the
 * aggregate cannot read returns `null`: the calendar disables the edit for that
 * occurrence instead of inventing a series.
 */
export const eventFromMirror = (
  record: MirrorRecord,
  fallback: { readonly userId: string; readonly householdId: string }
): Event | null => {
  const source = eventSourceFromMirror(record)
  const data = record.data
  const text = (value: unknown, fallbackValue: string): string =>
    typeof value === "string" && value !== "" ? value : fallbackValue
  try {
    return new Event({
      id: record.entityId as EventId,
      type: "event",
      title: source.title,
      description: source.description,
      location: source.location,
      category: source.category,
      people: [...source.people],
      timing: source.timing,
      timeZone: source.timeZone as Event["timeZone"],
      recurrence: source.recurrence,
      exceptions: [...source.exceptions],
      occasionId: (typeof data.occasionId === "string"
        ? data.occasionId
        : null) as Event["occasionId"],
      ownerId: text(data.ownerId, fallback.userId) as Event["ownerId"],
      householdId: text(data.householdId, fallback.householdId) as Event["householdId"],
      visibility: data.visibility === "private" ? "private" : "shared",
      color: source.color,
      createdAt: text(data.createdAt, record.updatedAt),
      updatedAt: record.updatedAt,
      version: record.version,
      deletedAt: record.deletedAt
    })
  } catch {
    return null
  }
}

export type { EventEditScope, EventExceptionOverrides }
