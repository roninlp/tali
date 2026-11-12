import { Option, Schema } from 'effect'

import {
  DEFAULT_TIME_ZONE,
  type Visibility,
  type VisibilityAggregate,
  defaultVisibilityFor,
  resolveTimeZone,
} from '@tali/domain'
import type { MirrorRecord } from '@tali/sync-client'

/**
 * The field rules every `toXRow` projector shares.
 *
 * A mirror row carries the aggregate's payload as untyped JSON, so each
 * projector has to answer the same questions: what is the id, what happens
 * when a text field is missing or empty, which zone do we assume, what does the
 * row's sync metadata look like, and which visibility does an absent value
 * fall back to. The answers live here once; a projector only spells out the
 * fields that are actually specific to its aggregate.
 */

// ── Decoders ─────────────────────────────────────────────────────────────

/** A present string, or `None` for anything else (including `null`). */
export const asOptionalString = Schema.decodeUnknownOption(Schema.String)

/**
 * A non-empty string, or `None`.
 *
 * Several rows treat an empty-string title or zone as absent rather than as a
 * value, so they decode through the non-empty form.
 */
export const asNonEmptyStringOption = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isMinLength(1)),
)

// ── Identity and text ────────────────────────────────────────────────────

/** The row's domain identity (the mirror keys every aggregate by it). */
export const mirrorId = (record: MirrorRecord): string => record.entityId

/** A text field with a fallback; `''` when the value is absent. */
export const mirrorText = (
  record: MirrorRecord,
  key: string,
  fallback = '',
): string =>
  Option.getOrElse(asOptionalString(record.data[key]), () => fallback)

/** A text field where an absent value stays `null` (a real optional field). */
export const mirrorNullableString = (
  record: MirrorRecord,
  key: string,
): string | null => Option.getOrNull(asOptionalString(record.data[key]))

/**
 * A nullable text field where an empty string also means absent.
 *
 * The event rows use this for their optional columns, so a cleared location or
 * category reads back the same as one that was never set.
 */
export const mirrorNullableNonEmpty = (
  record: MirrorRecord,
  key: string,
): string | null => Option.getOrNull(asNonEmptyStringOption(record.data[key]))

/** A text field that must have a value; the fallback is the caller's copy. */
export const mirrorNonEmpty = (
  record: MirrorRecord,
  key: string,
  fallback: string,
): string =>
  Option.getOrElse(asNonEmptyStringOption(record.data[key]), () => fallback)

// ── Zone and timestamps ──────────────────────────────────────────────────

/**
 * The row's zone, resolved through the domain's one validator.
 *
 * A row stored with a missing, empty or unknown zone reads as the household
 * default, so every screen formats the same instant the same way.
 */
export const mirrorTimeZone = (
  record: MirrorRecord,
  fallback = DEFAULT_TIME_ZONE,
): string => resolveTimeZone(mirrorNonEmpty(record, 'timeZone', fallback))

/** `data.createdAt`, or the row's server-stamped `updatedAt` when unset. */
export const mirrorCreatedAt = (record: MirrorRecord): string =>
  Option.getOrElse(
    asOptionalString(record.data.createdAt),
    () => record.updatedAt,
  )

// ── Sync metadata and visibility ─────────────────────────────────────────

/** The three fields every row carries from the mirror row itself. */
export const mirrorMeta = (record: MirrorRecord) => ({
  updatedAt: record.updatedAt,
  version: record.version,
  hasSyncError: record.syncError !== undefined,
})

/**
 * The row's settled visibility: an explicit `private`/`shared` wins, anything
 * else (missing, mistyped, or a legacy value) falls back to the aggregate's
 * policy default.
 */
export const mirrorVisibility = (
  record: MirrorRecord,
  entityType: VisibilityAggregate,
): Visibility => {
  const stored = record.data.visibility

  return stored === 'private' || stored === 'shared'
    ? stored
    : defaultVisibilityFor(entityType)
}
