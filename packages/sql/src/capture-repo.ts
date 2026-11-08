import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  Capture,
  type CaptureId,
  type CaptureStatus,
  type CaptureCreatedRow,
  type CaptureDraft,
  type UserId
} from "@tali/domain"

/**
 * D1-backed repository for the `capture` log (ticket #101; ADR-0012 §6).
 *
 * Capture is server-of-record and outside sync: these are plain
 * select/insert/update statements, with no `SyncRepo`, no version CAS, no feed
 * entry and no `applied_mutations` row. That is the structural guarantee that
 * a Dissect cannot write a row into the household's world.
 *
 * `drafts` and `created_ids` are JSON text; the aggregate is the boundary, so
 * a malformed row is a hard defect rather than a half-typed object.
 */

const CAPTURE_COLUMNS =
  `id, owner_id AS ownerId, text, status, drafts, created_ids AS createdIds, ` +
  `error, created_at AS createdAt, committed_at AS committedAt`

interface CaptureRow {
  readonly id: string
  readonly ownerId: string
  readonly text: string
  readonly status: string
  readonly drafts: string
  readonly createdIds: string
  readonly error: string | null
  readonly createdAt: string
  readonly committedAt: string | null
}

const toCapture = (row: CaptureRow): Capture =>
  Schema.decodeUnknownSync(Capture)({
    ...row,
    drafts: JSON.parse(row.drafts) as ReadonlyArray<CaptureDraft>,
    createdIds: JSON.parse(row.createdIds) as ReadonlyArray<CaptureCreatedRow>
  })

const encodeJson = (value: unknown): string => JSON.stringify(value)

export class CaptureRepo extends Context.Service<CaptureRepo>()("CaptureRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: CaptureId) =>
      Effect.map(
        sql<CaptureRow>`SELECT ${sql.literal(CAPTURE_COLUMNS)} FROM capture WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toCapture)
      )

    /** History: one owner's captures, newest first. */
    const listByOwner = (input: { readonly ownerId: UserId; readonly limit: number }) =>
      Effect.map(
        sql<CaptureRow>`
          SELECT ${sql.literal(CAPTURE_COLUMNS)} FROM capture
          WHERE owner_id = ${input.ownerId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit}
        `,
        (rows) => rows.map(toCapture)
      )

    /**
     * The 60-second identical-text dedupe. A failed capture is excluded: a
     * retry of a failed run must actually run again, while a parsed or
     * committed one is returned as-is.
     */
    const findRecentByDedupe = (input: {
      readonly ownerId: UserId
      readonly dedupeKey: string
      readonly since: string
    }) =>
      Effect.map(
        sql<CaptureRow>`
          SELECT ${sql.literal(CAPTURE_COLUMNS)} FROM capture
          WHERE owner_id = ${input.ownerId}
            AND dedupe_key = ${input.dedupeKey}
            AND status <> 'failed'
            AND created_at >= ${input.since}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toCapture)
      )

    const insert = (capture: Capture, dedupeKey: string) =>
      Effect.map(
        sql<CaptureRow>`
          INSERT INTO capture
            (id, owner_id, text, status, drafts, created_ids, error, dedupe_key,
             created_at, committed_at)
          VALUES
            (${capture.id}, ${capture.ownerId}, ${capture.text}, ${capture.status},
             ${encodeJson(capture.drafts)}, ${encodeJson(capture.createdIds)},
             ${capture.error}, ${dedupeKey}, ${capture.createdAt}, ${capture.committedAt})
          RETURNING ${sql.literal(CAPTURE_COLUMNS)}
        `,
        (rows) => toCapture(rows[0]!)
      )

    const update = (capture: Capture) =>
      Effect.map(
        sql<CaptureRow>`
          UPDATE capture SET
            text = ${capture.text},
            status = ${capture.status},
            drafts = ${encodeJson(capture.drafts)},
            created_ids = ${encodeJson(capture.createdIds)},
            error = ${capture.error},
            committed_at = ${capture.committedAt}
          WHERE id = ${capture.id}
          RETURNING ${sql.literal(CAPTURE_COLUMNS)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toCapture)
      )

    /** Set just the lifecycle status/error/drafts/created rows. */
    const setStatus = (input: {
      readonly id: CaptureId
      readonly status: CaptureStatus
      readonly drafts: ReadonlyArray<CaptureDraft>
      readonly createdIds: ReadonlyArray<CaptureCreatedRow>
      readonly error: string | null
      readonly committedAt: string | null
    }) =>
      Effect.map(
        sql<CaptureRow>`
          UPDATE capture SET
            status = ${input.status},
            drafts = ${encodeJson(input.drafts)},
            created_ids = ${encodeJson(input.createdIds)},
            error = ${input.error},
            committed_at = ${input.committedAt}
          WHERE id = ${input.id}
          RETURNING ${sql.literal(CAPTURE_COLUMNS)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toCapture)
      )

    /**
     * The nightly 90-day purge. Returns the ids that actually disappeared so
     * the maintenance log is a fact, not an estimate.
     */
    const purge = (cutoff: string) =>
      Effect.map(
        sql<{ readonly id: string }>`
          DELETE FROM capture
          WHERE created_at < ${cutoff}
          RETURNING id
        `,
        (rows) => rows.map((row) => row.id)
      )

    /** Drop rate-limit windows that are long past; keeps the table bounded. */
    const purgeAttemptsBefore = (windowStart: number) =>
      Effect.map(
        sql<{ readonly key: string }>`
          DELETE FROM capture_attempts
          WHERE window_start < ${windowStart}
          RETURNING key
        `,
        (rows) => rows.length
      )

    return {
      findById,
      listByOwner,
      findRecentByDedupe,
      insert,
      update,
      setStatus,
      purge,
      purgeAttemptsBefore
    } as const
  })
}) {}

export const CaptureRepoLive = Layer.effect(CaptureRepo, CaptureRepo.make)
