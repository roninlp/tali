import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  extractNotePlainText,
  type HouseholdId,
  Note,
  NoteConflict,
  NoteCreateInput,
  NoteFlagInput,
  NoteForbidden,
  type NoteId,
  NoteListInput,
  NoteMutationInput,
  NoteNotFound,
  NoteNotRestorable,
  type NotePatch,
  NoteSaveInput,
  NoteTagInput,
  NoteUpdateInput,
  NoteValidationError,
  NOTE_TRASH_RETENTION_MS,
  type SyncEntityType,
  type Tag,
  type TagId,
  type UserId,
  uuidV7,
  type Visibility
} from "@tali/domain"
import {
  NoteRepo,
  NoteRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
  TagRepo,
  TagRepoLive
} from "@tali/sql"
import { loadAssignableTags } from "./tag-guard.js"

/**
 * `NoteService` — quick create, autosave, tags, pin, archive, trash (#40;
 * FR-NOTE-01/03).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`).
 * A note changed here bumps `version`, appends a `change_feed` row and records
 * the mutation id in `applied_mutations`, so the mutation appears on
 * `/sync/pull` at the same version the RPC returned. Tag-join statements are
 * appended after the ledger inside the same batch.
 *
 * ## Idempotency
 *
 * `clientMutationId` replays return the stored row (a retry after a lost
 * response cannot write twice). `save()` additionally keys on `baseVersion`:
 * identical text is a no-op (repeated autosave never mints duplicate
 * versions), and text written against an older version fails with
 * `NoteConflict` carrying the current version instead of clobbering newer
 * server text.
 *
 * ## Trash
 *
 * Trash is the common soft delete (`deletedAt` + a `delete` feed op). Restore
 * is allowed for 30 days (`NOTE_TRASH_RETENTION_MS`); the purge job itself is
 * Slice 5 hardening.
 */

/** How many CAS retries a metadata update makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface NoteViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
}

export interface NoteServiceApi {
  readonly create: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteCreateInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly get: (viewer: NoteViewer, id: Note["id"]) => Effect.Effect<Note, NoteServiceError>
  /** Version-keyed autosave for the editor. */
  readonly save: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteSaveInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  /** Targeted metadata patch (title/tags/pin/archive/visibility/color). */
  readonly update: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteUpdateInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly setPinned: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteFlagInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly setArchived: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteFlagInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly setTags: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteTagInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly trash: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteMutationInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly restore: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteMutationInput>,
    now?: string
  ) => Effect.Effect<Note, NoteServiceError>
  readonly list: (
    viewer: NoteViewer,
    input: Schema.Schema.Type<typeof NoteListInput>
  ) => Effect.Effect<ReadonlyArray<Note>, NoteServiceError>
  /** The dashboard seam (#42): pinned, live, non-archived notes. */
  readonly listPinned: (
    viewer: NoteViewer
  ) => Effect.Effect<ReadonlyArray<Note>, NoteServiceError>
  readonly listTrash: (
    viewer: NoteViewer
  ) => Effect.Effect<ReadonlyArray<Note>, NoteServiceError>
}

export type NoteServiceError =
  | NoteNotFound
  | NoteForbidden
  | NoteValidationError
  | NoteConflict
  | NoteNotRestorable

const invalid = (field: string, message: string): Effect.Effect<never, NoteValidationError> =>
  Effect.fail(new NoteValidationError({ issues: [{ field, message }] }))

const sameTags = (a: ReadonlyArray<TagId>, b: ReadonlyArray<TagId>): boolean =>
  a.length === b.length && a.every((tagId, index) => tagId === b[index])

const sameBody = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export class NoteService extends Context.Service<NoteService>()("NoteService", {
  make: Effect.gen(function*() {
    const notes = yield* NoteRepo
    const tags = yield* TagRepo
    const sync = yield* SyncRepo

    const definition = (entityType: SyncEntityType) => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /** The aggregate through the same validation boundary the sync push uses. */
    const noteState = (note: Note): SyncEntityState => {
      const def = definition("note")
      return {
        entityType: "note",
        entityId: note.id,
        householdId: note.householdId,
        ownerId: note.ownerId,
        visibility: note.visibility,
        version: note.version,
        updatedAt: note.updatedAt,
        deletedAt: note.deletedAt,
        data: def.validate(
          { ...note } as Record<string, unknown>,
          { version: note.version, updatedAt: note.updatedAt, deletedAt: note.deletedAt }
        )
      }
    }

    const appliedMutation = (viewer: NoteViewer, clientMutationId: string) =>
      Effect.gen(function*() {
        const applied = yield* sync
          .findApplied({
            householdId: viewer.householdId,
            clientMutationIds: [clientMutationId]
          })
          .pipe(Effect.orDie)
        return Option.fromUndefinedOr(applied.get(clientMutationId))
      })

    /** A mutation id may not be reused for a different row or aggregate. */
    const reusedMutationId = (
      row: { readonly entityType: SyncEntityType; readonly entityId: string },
      expected: { readonly entityType: SyncEntityType; readonly id?: string }
    ): boolean =>
      row.entityType !== expected.entityType ||
      (expected.id !== undefined && row.entityId !== expected.id)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /**
     * One note mutation: CAS entity write, gated feed append, gated ledger row,
     * then tag-join statements — one D1 batch. Returns true when this mutation
     * id is recorded (i.e. the write, rather than a lost CAS, happened).
     */
    const commitNote = (input: {
      readonly viewer: NoteViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
      readonly tagChanges?: {
        readonly previous: ReadonlyArray<TagId>
        readonly next: ReadonlyArray<TagId>
      }
    }): Effect.Effect<boolean, NoteServiceError> =>
      Effect.gen(function*() {
        const prior = yield* appliedMutation(input.viewer, input.clientMutationId)
        if (
          Option.isSome(prior) &&
          reusedMutationId(prior.value, {
            entityType: input.state.entityType,
            id: input.state.entityId
          })
        ) {
          return yield* reusedMutationIdError(input.state.entityId)
        }

        const statements = [
          sync.writeEntity({ state: input.state, expectedVersion: input.expectedVersion }),
          sync.appendFeed({
            householdId: input.viewer.householdId,
            entityType: input.state.entityType,
            entityId: input.state.entityId,
            op: input.op ?? "upsert",
            version: input.state.version,
            updatedAt: input.state.updatedAt,
            ownerId: input.state.ownerId,
            visibility: input.state.visibility
          }),
          sync.recordApplied({
            clientMutationId: input.clientMutationId,
            householdId: input.viewer.householdId,
            entityType: input.state.entityType,
            entityId: input.state.entityId,
            version: input.state.version,
            createdAt: input.now
          })
        ]

        if (
          input.tagChanges !== undefined &&
          !sameTags(input.tagChanges.previous, input.tagChanges.next)
        ) {
          statements.push(
            notes.detachTagsIfVersion({
              noteId: input.state.entityId as NoteId,
              version: input.state.version,
              updatedAt: input.state.updatedAt
            }),
            ...input.tagChanges.next.map((tagId) =>
              notes.attachTagIfVersion({
                noteId: input.state.entityId as NoteId,
                tagId,
                householdId: input.viewer.householdId,
                createdAt: input.now,
                version: input.state.version,
                updatedAt: input.state.updatedAt
              })
            )
          )
        }

        yield* sync.commit(statements).pipe(Effect.orDie)
        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        return applied.has(input.clientMutationId)
      })

    const requireTags = (
      viewer: NoteViewer,
      tagIds: ReadonlyArray<TagId>
    ): Effect.Effect<ReadonlyArray<Tag>, NoteValidationError> =>
      loadAssignableTags(tags, viewer, tagIds).pipe(
        Effect.mapError((issue) => new NoteValidationError({ issues: [issue] }))
      )

    /**
     * Read one note with the standard scope rules. `includeTrashed` is used by
     * restore/replay; the default list/get semantics treat a tombstone as gone.
     */
    const readNote = (
      viewer: NoteViewer,
      id: NoteId,
      includeTrashed: boolean
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const found = yield* notes.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new NoteNotFound({ id }))
        }
        const note = found.value
        if (note.householdId !== viewer.householdId) {
          return yield* Effect.fail(new NoteForbidden({ id, reason: "household" }))
        }
        if (note.visibility === "private" && note.ownerId !== viewer.userId) {
          return yield* Effect.fail(new NoteForbidden({ id, reason: "private" }))
        }
        if (!includeTrashed && note.deletedAt !== null) {
          return yield* Effect.fail(new NoteNotFound({ id }))
        }
        return note
      })

    /** Replay guard: same mutation id + same row ⇒ return the stored note. */
    const replayNote = (
      viewer: NoteViewer,
      clientMutationId: string,
      expectedId?: NoteId
    ): Effect.Effect<Option.Option<Note>, NoteServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "note", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        const current = yield* readNote(viewer, row.value.entityId as NoteId, true)
        return Option.some(current)
      })

    const create = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        if (input.tagIds !== undefined) {
          yield* requireTags(viewer, input.tagIds)
        }

        const body = input.body ?? null
        const note = new Note({
          id: (input.id ?? uuidV7()) as Note["id"],
          type: "note",
          title: input.title ?? "",
          body,
          plainText: input.plainText ?? extractNotePlainText(body),
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          isPinned: input.isPinned ?? false,
          isArchived: input.isArchived ?? false,
          tagIds: input.tagIds ?? [],
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitNote({
          viewer,
          state: noteState(note),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now,
          tagChanges: { previous: [], next: note.tagIds }
        })
        if (!applied) return yield* Effect.fail(new NoteConflict({ id: note.id, version: 1 }))
        return note
      })

    const get = (viewer: NoteViewer, id: Note["id"]): Effect.Effect<Note, NoteServiceError> =>
      readNote(viewer, id, false)

    /**
     * Autosave. Text identical to the stored row is a no-op, and a stale
     * `baseVersion` with different text is a typed conflict — never a silent
     * overwrite of newer server text.
     */
    const save = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteSaveInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        const current = yield* readNote(viewer, input.id, false)
        const title = input.title ?? current.title
        const body = input.body === undefined ? current.body : input.body
        const plainText = input.body === undefined
          ? current.plainText
          : extractNotePlainText(input.body)

        // Repeated autosave of unchanged text must not mint a version.
        if (title === current.title && sameBody(body, current.body) && plainText === current.plainText) {
          return current
        }
        // The editor wrote against a version another writer already replaced.
        if (input.baseVersion !== current.version) {
          return yield* Effect.fail(new NoteConflict({ id: current.id, version: current.version }))
        }

        const next = new Note({
          ...current,
          title,
          body,
          plainText,
          version: current.version + 1,
          updatedAt: now
        })
        const applied = yield* commitNote({
          viewer,
          state: noteState(next),
          expectedVersion: current.version,
          clientMutationId: input.clientMutationId,
          now,
          tagChanges: { previous: current.tagIds, next: next.tagIds }
        })
        if (applied) return next

        // CAS lost after the read: another writer landed first. Report the
        // fresh version so the client can reconcile instead of retrying the
        // stale text blindly.
        const fresh = yield* readNote(viewer, input.id, false)
        return yield* Effect.fail(new NoteConflict({ id: fresh.id, version: fresh.version }))
      })

    const patchNote = (
      viewer: NoteViewer,
      current: Note,
      patch: NotePatch,
      now: string
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        if (patch.tagIds !== undefined) {
          yield* requireTags(viewer, patch.tagIds)
        }
        const body = patch.body !== undefined ? patch.body : current.body
        const plainText = patch.body !== undefined
          ? extractNotePlainText(patch.body)
          : (patch.plainText ?? current.plainText)
        return new Note({
          ...current,
          ...patch,
          body,
          plainText,
          version: current.version + 1,
          updatedAt: now
        })
      })

    const sameNoteFields = (a: Note, b: Note): boolean =>
      a.title === b.title &&
      sameBody(a.body, b.body) &&
      a.plainText === b.plainText &&
      a.isPinned === b.isPinned &&
      a.isArchived === b.isArchived &&
      a.color === b.color &&
      a.visibility === b.visibility &&
      sameTags(a.tagIds, b.tagIds)

    const update = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readNote(viewer, input.id, false)
          const next = yield* patchNote(viewer, current, input.patch, now)
          if (sameNoteFields(current, next)) return current
          const applied = yield* commitNote({
            viewer,
            state: noteState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        const fresh = yield* readNote(viewer, input.id, false)
        return yield* Effect.fail(new NoteConflict({ id: fresh.id, version: fresh.version }))
      })

    /** Idempotent pin/archive set: an unchanged flag writes nothing. */
    const setFlag = (
      field: "isPinned" | "isArchived",
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteFlagInput>,
      now: string
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readNote(viewer, input.id, false)
          if (current[field] === input.value) return current
          const next = new Note({
            ...current,
            [field]: input.value,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitNote({
            viewer,
            state: noteState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        const fresh = yield* readNote(viewer, input.id, false)
        return yield* Effect.fail(new NoteConflict({ id: fresh.id, version: fresh.version }))
      })

    const setPinned = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteFlagInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> => setFlag("isPinned", viewer, input, now)

    const setArchived = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteFlagInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> => setFlag("isArchived", viewer, input, now)

    const setTags = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteTagInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      update(
        viewer,
        { id: input.id, clientMutationId: input.clientMutationId, patch: { tagIds: input.tagIds } },
        now
      )

    const trash = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readNote(viewer, input.id, true)
          // Idempotent: trashing an already-trashed note writes nothing.
          if (current.deletedAt !== null) return current
          const next = new Note({
            ...current,
            deletedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitNote({
            viewer,
            state: noteState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            op: "delete",
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        const fresh = yield* readNote(viewer, input.id, true)
        return yield* Effect.fail(new NoteConflict({ id: fresh.id, version: fresh.version }))
      })

    const restore = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Note, NoteServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayNote(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readNote(viewer, input.id, true)
          if (current.deletedAt === null) return current
          if (
            Date.parse(now) - Date.parse(current.deletedAt) > NOTE_TRASH_RETENTION_MS
          ) {
            return yield* Effect.fail(
              new NoteNotRestorable({ id: current.id, deletedAt: current.deletedAt })
            )
          }
          const next = new Note({
            ...current,
            deletedAt: null,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitNote({
            viewer,
            state: noteState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            tagChanges: { previous: current.tagIds, next: next.tagIds }
          })
          if (applied) return next
        }
        const fresh = yield* readNote(viewer, input.id, true)
        return yield* Effect.fail(new NoteConflict({ id: fresh.id, version: fresh.version }))
      })

    const list = (
      viewer: NoteViewer,
      input: Schema.Schema.Type<typeof NoteListInput>
    ): Effect.Effect<ReadonlyArray<Note>, NoteServiceError> =>
      Effect.gen(function*() {
        const scope = { householdId: viewer.householdId, userId: viewer.userId }
        const rows = yield* (input.includeArchived === true
          ? notes.listVisible(scope)
          : notes.listActive(scope)
        ).pipe(Effect.orDie)
        const filter = input.tagIds
        if (filter === undefined || filter.length === 0) return rows
        // Chip filter is OR: any selected tag matches.
        return rows.filter((note) => note.tagIds.some((tagId) => filter.includes(tagId)))
      })

    const listPinned = (
      viewer: NoteViewer
    ): Effect.Effect<ReadonlyArray<Note>, NoteServiceError> =>
      notes
        .listPinned({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    const listTrash = (
      viewer: NoteViewer
    ): Effect.Effect<ReadonlyArray<Note>, NoteServiceError> =>
      notes
        .listTrashed({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    return {
      create,
      get,
      save,
      update,
      setPinned,
      setArchived,
      setTags,
      trash,
      restore,
      list,
      listPinned,
      listTrash
    } as const
  })
}) {}

export const NoteServiceLive = Layer.effect(NoteService, NoteService.make).pipe(
  Layer.provide(NoteRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(SyncRepoLive)
)
