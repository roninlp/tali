import { Context, Effect, Layer, Option, Result } from "effect"
import {
  CAPTURE_DEDUPE_WINDOW_MS,
  CAPTURE_MAX_DRAFTS,
  CAPTURE_MAX_TEXT_LENGTH,
  type Capture,
  type CaptureCommitFailure,
  type CommitCaptureInput,
  type CaptureCommitResult,
  type CaptureCreatedRow,
  type CaptureCreateInput,
  type CaptureDraft,
  type CaptureId,
  type CaptureServiceError,
  CaptureEmpty,
  CaptureNotFound,
  CaptureRateLimited,
  CaptureTooLong,
  type DeleteCaptureInput,
  DraftIncomplete,
  type DissectCaptureInput,
  type HouseholdId,
  type ListCapturesInput,
  type UserId,
  type WeekStart,
  captureDedupeKey,
  normalizeCaptureText,
  toCreateInput,
  uuidV7
} from "@tali/domain"
import { CaptureRepo, CaptureRepoLive } from "@tali/sql"
import { CaptureRateLimiter, CaptureRateLimiterLive } from "./capture-rate-limiter.js"
import { Extractor } from "./capture-extractor.js"
import { EventService, EventServiceLive } from "./event-service.js"
import { HabitService, HabitServiceLive } from "./habit-service.js"
import { NoteService, NoteServiceLive } from "./note-service.js"
import { ReminderService, ReminderServiceLive } from "./reminder-service.js"
import { TaskService, TaskServiceLive } from "./task-service.js"

/**
 * `CaptureService` — the Dissect/commit orchestration (ticket #101; ADR-0012).
 *
 * ## Dissect
 *
 * Normalize → dedupe → rate limit → insert a `pending` row → run the Extractor
 * → mark `parsed` or `failed`. A model failure is recorded on the row (the
 * text is never lost) rather than thrown away; a too-long, empty or
 * rate-limited request is a typed failure before a row exists.
 *
 * ## Commit
 *
 * Read the owner's row → block unanswered Needs Input → validate every draft
 * against its real create schema (nothing is written on failure) → apply the
 * drafts in order through the existing services, each with a deterministic
 * `clientMutationId`. A mid-way failure reports the rows that landed and the
 * index that stopped; a retry replays the same keys, so `applied_mutations`
 * dedupes the earlier rows.
 */

/** The viewer a Capture call runs as; owner-only, but it needs the household. */
export interface CaptureViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  readonly timeZone: string
  readonly weekStart: WeekStart
}

export interface CaptureServiceApi {
  readonly dissect: (
    viewer: CaptureViewer,
    input: DissectCaptureInput,
    now?: string
  ) => Effect.Effect<Capture, CaptureServiceError>
  readonly commit: (
    viewer: CaptureViewer,
    input: CommitCaptureInput,
    now?: string
  ) => Effect.Effect<CaptureCommitResult, CaptureServiceError>
  readonly list: (
    viewer: CaptureViewer,
    input: ListCapturesInput
  ) => Effect.Effect<ReadonlyArray<Capture>, CaptureServiceError>
  /** Drop one owned history row (the UI offers it on failed entries). */
  readonly remove: (
    viewer: CaptureViewer,
    input: DeleteCaptureInput
  ) => Effect.Effect<Capture, CaptureServiceError>
}

export class CaptureService extends Context.Service<CaptureService>()("CaptureService", {
  make: Effect.gen(function*() {
    const captures = yield* CaptureRepo
    const limiter = yield* CaptureRateLimiter
    const extractor = yield* Extractor
    const tasks = yield* TaskService
    const events = yield* EventService
    const notes = yield* NoteService
    const habits = yield* HabitService
    const reminders = yield* ReminderService

    const readOwned = (
      viewer: CaptureViewer,
      id: CaptureId
    ): Effect.Effect<Capture, CaptureServiceError> =>
      Effect.gen(function*() {
        const found = yield* captures.findById(id).pipe(Effect.orDie)
        // Another owner's row is indistinguishable from a missing one.
        if (Option.isNone(found) || found.value.ownerId !== viewer.userId) {
          return yield* Effect.fail(new CaptureNotFound({ id }))
        }
        return found.value
      })

    const failureMessage = (error: CaptureServiceError): string =>
      error._tag === "ModelUnavailable"
        ? error.message
        : error._tag === "ModelTimeout"
        ? "مدل در ۶۰ ثانیه پاسخ نداد"
        : error._tag

    const dissect = (
      viewer: CaptureViewer,
      input: DissectCaptureInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<Capture, CaptureServiceError> =>
      Effect.gen(function*() {
        const text = normalizeCaptureText(input.text)
        if (text === "") {
          return yield* Effect.fail(new CaptureEmpty())
        }
        if (text.length > CAPTURE_MAX_TEXT_LENGTH) {
          return yield* Effect.fail(
            new CaptureTooLong({ length: text.length, max: CAPTURE_MAX_TEXT_LENGTH })
          )
        }

        // Dedupe before the limiter: an accidental double-submit must not
        // spend a slot or a model run (ADR-0012 §9).
        const dedupeKey = captureDedupeKey(text)
        const since = new Date(Date.parse(now) - CAPTURE_DEDUPE_WINDOW_MS).toISOString()
        const existing = yield* captures
          .findRecentByDedupe({ ownerId: viewer.userId, dedupeKey, since })
          .pipe(Effect.orDie)
        if (Option.isSome(existing)) return existing.value

        const limit = yield* limiter.consume(viewer.userId)
        if (limit.limited) {
          return yield* Effect.fail(
            new CaptureRateLimited({ retryAfterSeconds: limit.retryAfterSeconds })
          )
        }

        const pending: Capture = {
          id: uuidV7() as CaptureId,
          ownerId: viewer.userId,
          text,
          status: "pending",
          drafts: [],
          createdIds: [],
          error: null,
          createdAt: now,
          committedAt: null
        }
        yield* captures.insert(pending, dedupeKey).pipe(Effect.orDie)

        const result = yield* extractor
          .dissect({
            userId: viewer.userId,
            text,
            now,
            timeZone: viewer.timeZone,
            weekStart: viewer.weekStart
          })
          .pipe(Effect.result)

        if (Result.isFailure(result)) {
          const failed = yield* captures
            .setStatus({
              id: pending.id,
              status: "failed",
              drafts: [],
              createdIds: [],
              error: failureMessage(result.failure),
              committedAt: null
            })
            .pipe(Effect.orDie)
          return Option.getOrElse(failed, () => ({
            ...pending,
            status: "failed",
            error: failureMessage(result.failure)
          }))
        }

        const parsed = yield* captures
          .setStatus({
            id: pending.id,
            status: "parsed",
            drafts: result.success,
            createdIds: [],
            error: null,
            committedAt: null
          })
          .pipe(Effect.orDie)
        return Option.getOrElse(parsed, () => ({
          ...pending,
          status: "parsed",
          drafts: result.success
        }))
      })

    const sha256Hex = async (value: string): Promise<string> => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value)
      )
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    }

    /**
     * `f(captureId, draftIndex, draftHash)` (ADR-0012 §5). A retry of the
     * same reviewed draft produces the same key, so the create service's
     * `applied_mutations` row makes it a no-op.
     */
    const mutationIdFor = (
      captureId: CaptureId,
      draftIndex: number,
      draft: CaptureDraft
    ): Effect.Effect<string> =>
      Effect.promise(async () => {
        const hash = await sha256Hex(JSON.stringify(draft))
        return `capture:${captureId}:${draftIndex}:${hash.slice(0, 32)}`
      })

    const createdRow = (row: {
      readonly id: string
      readonly title: string
    }, type: CaptureCreatedRow["type"]): CaptureCreatedRow => ({
      type,
      id: row.id,
      title: row.title
    })

    const applyCreate = (
      viewer: CaptureViewer,
      create: CaptureCreateInput,
      now: string
    ): Effect.Effect<CaptureCreatedRow, unknown> => {
      switch (create._tag) {
        case "task":
          return tasks.create(viewer, create.input, now).pipe(
            Effect.map((row) => createdRow(row, "task"))
          )
        case "event":
          return events.create(viewer, create.input, now).pipe(
            Effect.map((row) => createdRow(row, "event"))
          )
        case "note":
          return notes.create(viewer, create.input, now).pipe(
            Effect.map((row) => createdRow(row, "note"))
          )
        case "habit":
          return habits.create(viewer, create.input, now).pipe(
            Effect.map((row) => createdRow(row, "habit"))
          )
        case "reminder":
          return reminders.create(viewer, create.input, now).pipe(
            Effect.map((row) => createdRow(row, "reminder"))
          )
      }
    }

    const errorLabel = (error: unknown): string => {
      if (error !== null && typeof error === "object" && "_tag" in error) {
        return String(error._tag)
      }
      return error instanceof Error ? error.message : "unknown"
    }

    const commit = (
      viewer: CaptureViewer,
      input: CommitCaptureInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<CaptureCommitResult, CaptureServiceError> =>
      Effect.gen(function*() {
        const capture = yield* readOwned(viewer, input.captureId)
        if (capture.status === "committed") {
          return {
            capture,
            created: capture.createdIds,
            failure: null,
            remaining: 0
          }
        }

        const drafts = input.drafts.slice(0, CAPTURE_MAX_DRAFTS)

        // A visible card with an unanswered Needs Input blocks the commit
        // before any validation or write (ADR-0012 §4).
        const unanswered = drafts.findIndex((draft) => draft.missing.length > 0)
        if (unanswered >= 0) {
          return yield* Effect.fail(
            new DraftIncomplete({
              draftIndex: unanswered,
              fields: drafts[unanswered]!.missing.map((entry) => entry.field)
            })
          )
        }

        // Validate every card first: one bad card fails the request and
        // nothing is written (ADR-0012 §5).
        const prepared = yield* Effect.forEach(
          drafts,
          (draft, draftIndex) =>
            Effect.gen(function*() {
              const clientMutationId = yield* mutationIdFor(
                capture.id,
                draftIndex,
                draft
              )
              const create = yield* toCreateInput(draft, {
                draftIndex,
                clientMutationId,
                timeZone: viewer.timeZone
              })
              return { draftIndex, create }
            }),
          { concurrency: 1 }
        )

        // Persist the reviewed drafts so a reload resumes the same cards. The
        // status stays `parsed` until every draft has landed.
        yield* captures
          .setStatus({
            id: capture.id,
            status: "parsed",
            drafts,
            createdIds: capture.createdIds,
            error: null,
            committedAt: null
          })
          .pipe(Effect.orDie)

        const created: Array<CaptureCreatedRow> = [...capture.createdIds]
        let failure: CaptureCommitFailure | null = null
        let remaining = 0

        for (const item of prepared) {
          if (failure !== null) continue
          const outcome = yield* applyCreate(viewer, item.create, now).pipe(
            Effect.result
          )
          if (Result.isFailure(outcome)) {
            failure = {
              draftIndex: item.draftIndex,
              error: errorLabel(outcome.failure)
            }
            continue
          }
          if (!created.some((row) => row.id === outcome.success.id)) {
            created.push(outcome.success)
          }
        }
        if (failure !== null) {
          remaining = prepared.length - failure.draftIndex
        }

        const status = failure === null ? "committed" : "parsed"
        const updated = yield* captures
          .setStatus({
            id: capture.id,
            status,
            drafts,
            createdIds: created,
            error: failure?.error ?? null,
            committedAt: failure === null ? now : null
          })
          .pipe(Effect.orDie)

        return {
          capture: Option.getOrElse(updated, () => ({
            ...capture,
            status,
            drafts,
            createdIds: created,
            error: failure?.error ?? null,
            committedAt: failure === null ? now : null
          })),
          created,
          failure,
          remaining
        }
      })

    const list = (
      viewer: CaptureViewer,
      input: ListCapturesInput
    ): Effect.Effect<ReadonlyArray<Capture>, CaptureServiceError> =>
      captures
        .listByOwner({ ownerId: viewer.userId, limit: input.limit ?? 20 })
        .pipe(Effect.orDie)

    /**
     * Remove one owned history row. Another owner's row is indistinguishable
     * from a missing one, exactly like `readOwned`.
     */
    const remove = (
      viewer: CaptureViewer,
      input: DeleteCaptureInput
    ): Effect.Effect<Capture, CaptureServiceError> =>
      Effect.gen(function*() {
        const capture = yield* readOwned(viewer, input.captureId)
        const removed = yield* captures
          .remove({ id: capture.id, ownerId: viewer.userId })
          .pipe(Effect.orDie)
        if (!removed) {
          return yield* Effect.fail(new CaptureNotFound({ id: input.captureId }))
        }
        return capture
      })

    return { dissect, commit, list, remove } as const
  })
}) {}

export const CaptureServiceLive = Layer.effect(CaptureService, CaptureService.make).pipe(
  Layer.provide(CaptureRepoLive),
  Layer.provide(CaptureRateLimiterLive),
  Layer.provide(TaskServiceLive),
  Layer.provide(EventServiceLive),
  Layer.provide(NoteServiceLive),
  Layer.provide(HabitServiceLive),
  Layer.provide(ReminderServiceLive)
)
