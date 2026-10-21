import {
  Event,
  deleteEventOccurrence,
  eventAnchorDate,
  isEventOccurrence,
  overrideEventOccurrence,
  patchEventSeries,
  splitEventSeries,
  trashEvent,
  truncateEventSeries,
  uuidV7,
  type EventEditScope,
  type EventExceptionId,
  type EventExceptionOverrides,
  type EventId,
  type EventOccurrenceChange,
  type EventOccurrenceDeleteInput,
  type EventOccurrenceEditInput,
  type LocalDate
} from "@tali/domain"
import type { LocalStore, MirrorRecord, ServerRow } from "../local-store"
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
 * ## Why the server path is the primary one
 *
 * A split is **two rows** and #58's service writes them in one batch with the
 * tail's insert *gated on the exact truncated head*. The generic `/sync/push`
 * resolver has no cross-entity gate: each queued row is an independent
 * last-writer-wins mutation, sent one-per-entity. A queued second row can
 * therefore travel before the truncation (when an earlier mutation of the head
 * is still in the outbox), or travel alone after the truncation was rejected or
 * lost its version. Either outcome leaves two live halves painting the future
 * twice, and there is no way for the client to make that safe by ordering the
 * two writes.
 *
 * So a recurring series' occurrence edit goes through
 * `EditEventOccurrence`/`DeleteEventOccurrence` whenever the device is online
 * and the head has no queued mutation. Those RPCs keep the service's CAS gate,
 * its gated tail insert, and their client-minted replay keys (the screen mints
 * the ids once per prompt, so a retry is exactly-once).
 *
 * ## What still works offline
 *
 * A series' **single-row** scopes are ordinary local-first mutations and stay
 * on the mirror + outbox path: "this occurrence" (edit or delete) and "this and
 * following" **delete** (one truncate/tombstone). A split **edit** is refused
 * offline (and while the head has an unsent mutation) with
 * `SPLIT_REQUIRES_SERVER`, because the outbox cannot uphold the gate.
 *
 * A one-off event has no series and no gate: its edit/delete stays local-first
 * even online, exactly like every other single-row write in the app.
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

/** A split edit is the one scope the local outbox cannot make atomic. */
export const SPLIT_REQUIRES_SERVER =
  "برای «این رویداد و رویدادهای بعدی» باید به سرور متصل باشید و این رویداد همگام شده باشد."

const notAnOccurrence = (instanceId: string): Error =>
  new Error(`این روز (${instanceId}) یکی از رویدادهای این مجموعه نیست؛ صفحه را تازه کنید.`)

/**
 * The occurrence the caller asked for must really belong to this series.
 *
 * The service validates the same thing before writing. Repeating it here keeps
 * the local fallback from silently degrading an unknown instance into a
 * whole-series edit (`patchEventSeries`), which would rewrite occurrences
 * before the chosen day.
 */
const assertOccurrence = (event: Event, instanceId: string): void => {
  if (!isEventOccurrence(event, instanceId)) throw notAnOccurrence(instanceId)
}

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
    if (instanceId !== eventAnchorDate(event)) throw notAnOccurrence(instanceId)
    return { series: patchEventSeries(event, overrides, input.now), following: null }
  }

  assertOccurrence(event, instanceId)

  if (scope === "thisAndFollowing") {
    const stored = event.exceptions.find((exception) => exception.instanceId === instanceId)
    if (stored?.action === "delete") {
      throw new Error("مجموعه نمی‌تواند از روزی شروع شود که حذف شده است.")
    }
    // Nothing precedes the first occurrence: the whole series takes the edit.
    if (instanceId === eventAnchorDate(event)) {
      return { series: patchEventSeries(event, overrides, input.now), following: null }
    }
    const split = splitEventSeries({
      event,
      instanceId,
      overrides,
      followingId: input.followingId,
      now: input.now
    })
    if (split === null) throw notAnOccurrence(instanceId)
    return { series: split.previous, following: split.following }
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
    if (instanceId !== eventAnchorDate(event)) throw notAnOccurrence(instanceId)
    return { series: trashEvent(event, input.now), following: null }
  }
  assertOccurrence(event, instanceId)
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
 * Commit the **single-row** half of a scoped change to the mirror + outbox.
 *
 * Only callers that may queue one independent LWW mutation reach this: the
 * one-off path, "this occurrence", and "this and following" delete. A split
 * (two rows) is refused here on purpose — it must go through the service's
 * gated batch (`commitEventScope`), because the outbox cannot order the pair
 * against a concurrent head write.
 */
export const applyEventScopeInMirror = async (
  store: LocalStore,
  change: EventScopeChange,
  now: string = new Date().toISOString()
): Promise<void> => {
  if (change.following !== null) throw new Error(SPLIT_REQUIRES_SERVER)
  await store.writeLocal({
    entityType: "event",
    entityId: change.series.id,
    op: isTombstoned(change.series) ? "delete" : "upsert",
    patch: eventWritePatch(change.series),
    now
  })
}

/** A fresh exception id / split id / replay key for one scoped action. */
export interface EventScopeIds {
  readonly exceptionId: string
  readonly followingId: string
  /** The head mutation's replay key (`Edit/DeleteEventOccurrence`). */
  readonly clientMutationId: string
  /** The split tail's replay key; unused for every other scope. */
  readonly followingMutationId: string
}

export const newScopedIds = (): EventScopeIds => ({
  exceptionId: uuidV7(),
  followingId: uuidV7(),
  clientMutationId: uuidV7(),
  followingMutationId: uuidV7()
})

/** The server mutations a scoped edit needs; injectable for tests. */
export interface EventScopeServer {
  readonly editOccurrence: (
    input: EventOccurrenceEditInput
  ) => Promise<EventOccurrenceChange>
  readonly deleteOccurrence: (
    input: EventOccurrenceDeleteInput
  ) => Promise<EventOccurrenceChange>
}

export interface CommitEventScopeInput {
  readonly store: LocalStore
  /** `local.online()` at the moment of the action. */
  readonly online: boolean
  readonly server: EventScopeServer
  readonly event: Event
  readonly instanceId: string
  readonly action: "edit" | "delete"
  readonly scope: EventEditScope
  readonly overrides: EventExceptionOverrides
  readonly ids: EventScopeIds
  readonly now?: string
}

export interface EventScopeCommitResult {
  /** `server` = the service's gated batch; `mirror` = a local LWW write. */
  readonly source: "server" | "mirror"
  readonly series: Event
  readonly following: Event | null
}

const serverRowOf = (event: Event): ServerRow => ({
  entityType: "event",
  entityId: event.id,
  version: event.version,
  updatedAt: event.updatedAt,
  deletedAt: event.deletedAt,
  data: { ...event }
})

/**
 * Adopt the authoritative rows an occurrence mutation returned.
 *
 * These are **not** queued: the server already has them. `mergeServer` leaves
 * a row alone when it still has an outbox entry (the caller only takes this
 * path when the head has none), so an unsent local edit can never be clobbered.
 */
export const applyEventChangeFromServer = async (
  store: LocalStore,
  change: EventOccurrenceChange
): Promise<void> => {
  const rows = change.following === null
    ? [serverRowOf(change.series)]
    : [serverRowOf(change.series), serverRowOf(change.following)]
  await store.mergeServer(rows)
}

/**
 * The calendar's one write path for a scoped occurrence action.
 *
 * - A one-off event (no recurrence, no gate) stays local-first online or off.
 * - A series on a **connected** device with no unsent head mutation uses the
 *   service RPC, which owns the CAS gate, the gated tail and the replay keys.
 * - A series offline (or with an unsent head) uses the local single-row path;
 *   a split **edit** is refused with `SPLIT_REQUIRES_SERVER`.
 *
 * A failed RPC is surfaced, never replayed locally: the request may have
 * committed (a lost response is exactly what the service's `clientMutationId`
 * guards), and a second, generic push would mint a second tail.
 */
export const commitEventScope = async (
  input: CommitEventScopeInput
): Promise<EventScopeCommitResult> => {
  const now = input.now ?? new Date().toISOString()

  const local = async (): Promise<EventScopeCommitResult> => {
    if (input.action === "edit" && input.scope === "thisAndFollowing") {
      throw new Error(SPLIT_REQUIRES_SERVER)
    }
    const change = input.action === "edit"
      ? editEventWithinScope({
        event: input.event,
        instanceId: input.instanceId,
        overrides: input.overrides,
        scope: input.scope,
        exceptionId: input.ids.exceptionId,
        followingId: input.ids.followingId,
        now
      })
      : deleteEventWithinScope({
        event: input.event,
        instanceId: input.instanceId,
        scope: input.scope,
        exceptionId: input.ids.exceptionId,
        followingId: input.ids.followingId,
        now
      })
    await applyEventScopeInMirror(input.store, change, now)
    return { source: "mirror", series: change.series, following: change.following }
  }

  // A one-off is an ordinary single-row edit; the outbox is its established
  // path and there is no split to gate.
  if (input.event.recurrence === null) return local()
  if (!input.online) return local()
  if (await input.store.hasPending("event", input.event.id)) return local()

  const base = {
    id: input.event.id,
    instanceId: input.instanceId as LocalDate,
    clientMutationId: input.ids.clientMutationId,
    scope: input.scope,
    exceptionId: input.ids.exceptionId as EventExceptionId
  } as const
  const change = input.action === "edit"
    ? await input.server.editOccurrence({
      ...base,
      ...(input.scope === "thisAndFollowing"
        ? {
          followingId: input.ids.followingId as EventId,
          followingMutationId: input.ids.followingMutationId
        }
        : {}),
      overrides: input.overrides
    })
    : await input.server.deleteOccurrence(base)
  await applyEventChangeFromServer(input.store, change)
  return { source: "server", series: change.series, following: change.following }
}

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
