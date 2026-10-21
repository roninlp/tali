import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  Habit,
  HabitConflict,
  HabitCreateInput,
  HabitFrequency,
  HabitForbidden,
  type HabitId,
  type HabitPatch,
  HabitValidationError,
  HabitMutationInput,
  HabitNotFound,
  type HabitServiceError,
  HabitUpdateInput,
  type HouseholdId,
  habitFrequencyHistoryAfter,
  localDateIn,
  sameHabitFrequency,
  type SyncEntityType,
  type UserId,
  type Visibility,
  uuidV7
} from "@tali/domain"
import { HabitRepo, HabitRepoLive, type SyncEntityState, SyncRepo, SyncRepoLive } from "@tali/sql"

/**
 * `HabitService` — create, edit, delete and restore (ticket #63; FR-HAB-01).
 *
 * ## Write path
 *
 * Every mutation is exactly one `D1Client.batch()` built from the #34 sync
 * primitives (`writeEntity` + gated `appendFeed` + gated `recordApplied`).
 * Reusing those primitives means the service path and the sync-push path share
 * one version/feed implementation: a habit changed here bumps `version`,
 * appends a `change_feed` row, and is visible to `/sync/pull`.
 *
 * `clientMutationId` makes a mutation replay-safe. A retry after a lost
 * response finds the id in `applied_mutations` and returns the current row
 * instead of applying twice. A lost version CAS (another writer landed between
 * our read and our batch) writes nothing; the service re-reads and reapplies
 * the same patch, so a field is never silently dropped.
 *
 * ## The frequency is versioned
 *
 * A create seeds `frequencyHistory` with the frequency's first version on the
 * owner's local date. A frequency change appends a version
 * (`habitFrequencyHistoryAfter`) instead of rewriting the past, so the
 * stats/streak algorithm (#65) can evaluate a past day against the frequency
 * that was in force then. The same helper is used by the offline sync merge, so
 * the two write paths cannot drift.
 *
 * ## Delete is a soft delete, and it is undoable
 *
 * `delete` stamps a `deletedAt` tombstone (the shared 30-day-trash contract) and
 * records a `delete` op on the feed, so the other member's device drops it.
 * `restore` revives the same row — same id, same history, same entries — which
 * is what the undo toast on the habits screen (#66) calls.
 *
 * ## What this service does not do
 *
 * It never writes a `HabitEntry`. The daily tap, the status cycle and the
 * ≤ 7-day backdating window are ticket #64's service, built on
 * `HabitEntryRepo`; this ticket ships the entry table, model and sync path.
 */

/** How many CAS retries a service mutation makes before reporting contention. */
const MAX_CAS_ATTEMPTS = 3

export interface HabitViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** The viewer's zone: the default zone of a new habit. */
  readonly timeZone: string
}

export interface HabitServiceApi {
  readonly create: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitCreateInput>,
    now?: string
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly get: (viewer: HabitViewer, id: Habit["id"]) => Effect.Effect<Habit, HabitServiceError>
  readonly update: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitUpdateInput>,
    now?: string
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly delete: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitMutationInput>,
    now?: string
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly restore: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitMutationInput>,
    now?: string
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly list: (viewer: HabitViewer) => Effect.Effect<ReadonlyArray<Habit>, HabitServiceError>
}

const invalid = (field: string, message: string): Effect.Effect<never, HabitValidationError> =>
  Effect.fail(new HabitValidationError({ issues: [{ field, message }] }))

export class HabitService extends Context.Service<HabitService>()("HabitService", {
  make: Effect.gen(function*() {
    const habits = yield* HabitRepo
    const sync = yield* SyncRepo

    const definition = (entityType: SyncEntityType) => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /**
     * Turn a validated aggregate into the registry's trusted write state. The
     * registration's `validate` boundary is the same one the sync push uses,
     * so a service write can never put a shape on the wire that a pull would
     * reject.
     */
    const habitState = (habit: Habit): SyncEntityState => {
      const def = definition("habit")
      return {
        entityType: "habit",
        entityId: habit.id,
        householdId: habit.householdId,
        ownerId: habit.ownerId,
        visibility: habit.visibility,
        version: habit.version,
        updatedAt: habit.updatedAt,
        deletedAt: habit.deletedAt,
        data: def.validate(
          { ...habit } as Record<string, unknown>,
          { version: habit.version, updatedAt: habit.updatedAt, deletedAt: habit.deletedAt }
        )
      }
    }

    const appliedMutation = (viewer: HabitViewer, clientMutationId: string) =>
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

    /** One CAS entity write with its gated feed append and gated ledger row. */
    const commitHabit = (input: {
      readonly viewer: HabitViewer
      readonly state: SyncEntityState
      readonly expectedVersion: number | null
      readonly clientMutationId: string
      readonly now: string
      readonly op?: "upsert" | "delete"
    }): Effect.Effect<boolean, HabitServiceError> =>
      Effect.gen(function*() {
        // A mutation id is one mutation for its whole retention window. If the
        // ledger already maps it to a different row/aggregate, `recordApplied`
        // would be an `INSERT OR IGNORE` no-op: the write would land with no
        // replay guard. Refuse before writing.
        const prior = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        const row = Option.fromUndefinedOr(prior.get(input.clientMutationId))
        if (
          Option.isSome(row) &&
          reusedMutationId(row.value, {
            entityType: input.state.entityType,
            id: input.state.entityId
          })
        ) {
          return yield* reusedMutationIdError(input.state.entityId)
        }

        yield* sync
          .commit([
            sync.writeEntity({
              state: input.state,
              expectedVersion: input.expectedVersion
            }),
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
          ])
          .pipe(Effect.orDie)

        const applied = yield* sync
          .findApplied({
            householdId: input.viewer.householdId,
            clientMutationIds: [input.clientMutationId]
          })
          .pipe(Effect.orDie)
        return applied.has(input.clientMutationId)
      })

    /**
     * Read one habit with the standard scope rules. A tombstone reads as
     * "gone" unless the caller asks for it (the replay/restore guards do).
     */
    const readHabit = (
      viewer: HabitViewer,
      id: HabitId,
      includeTrashed: boolean
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        const found = yield* habits.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found)) {
          return yield* Effect.fail(new HabitNotFound({ id }))
        }
        const habit = found.value
        if (habit.householdId !== viewer.householdId) {
          return yield* Effect.fail(new HabitForbidden({ id, reason: "household" }))
        }
        if (habit.visibility === "private" && habit.ownerId !== viewer.userId) {
          return yield* Effect.fail(new HabitForbidden({ id, reason: "private" }))
        }
        if (!includeTrashed && habit.deletedAt !== null) {
          return yield* Effect.fail(new HabitNotFound({ id }))
        }
        return habit
      })

    /** Replay guard: the same mutation id already committed (lost response). */
    const replayHabit = (
      viewer: HabitViewer,
      clientMutationId: string,
      expectedId?: HabitId
    ): Effect.Effect<Option.Option<Habit>, HabitServiceError> =>
      Effect.gen(function*() {
        const row = yield* appliedMutation(viewer, clientMutationId)
        if (Option.isNone(row)) return Option.none()
        if (reusedMutationId(row.value, { entityType: "habit", id: expectedId })) {
          return yield* reusedMutationIdError(expectedId ?? row.value.entityId)
        }
        // Same household/owner rules as any other read: a mutation id may
        // never hand back another member's private row.
        const current = yield* readHabit(viewer, row.value.entityId as HabitId, true)
        return Option.some(current)
      })

    /**
     * Decode + validate the frequency union against the one shared contract.
     *
     * The RPC payload is decoded at the edge already, but the service is also
     * the boundary for direct callers (tests, the HTTP layer later): the union
     * is re-checked so an empty or duplicate weekday selection can never be
     * stored.
     */
    const decodeFrequency = (
      frequency: HabitFrequency
    ): Effect.Effect<HabitFrequency, HabitValidationError> => {
      const decoded = Schema.decodeUnknownOption(HabitFrequency)(frequency)
      return decoded._tag === "Some"
        ? Effect.succeed(decoded.value)
        : invalid("frequency", "the frequency is not a valid habit rhythm")
    }

    const create = (
      viewer: HabitViewer,
      input: Schema.Schema.Type<typeof HabitCreateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayHabit(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        if (input.title.trim().length === 0) {
          return yield* invalid("title", "a habit needs a title")
        }
        const frequency = yield* decodeFrequency(input.frequency)
        const timeZone = input.timeZone ?? viewer.timeZone

        const habit = new Habit({
          id: (input.id ?? uuidV7()) as Habit["id"],
          type: "habit",
          title: input.title,
          description: input.description ?? null,
          icon: input.icon ?? null,
          frequency,
          // The first version starts on the owner's local creation day, in the
          // habit's zone — the same rule an offline create uses.
          frequencyHistory: [
            { effectiveFrom: localDateIn(now, timeZone), frequency }
          ],
          reminderTime: input.reminderTime ?? null,
          timeZone,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })

        const applied = yield* commitHabit({
          viewer,
          state: habitState(habit),
          expectedVersion: null,
          clientMutationId: input.clientMutationId,
          now
        })
        if (!applied) {
          return yield* Effect.fail(new HabitConflict({ id: habit.id }))
        }
        return habit
      })

    const get = (viewer: HabitViewer, id: Habit["id"]): Effect.Effect<Habit, HabitServiceError> =>
      readHabit(viewer, id, false)

    /** Apply a patch to a row, versioning the frequency when it changes. */
    const patchHabit = (
      current: Habit,
      patch: Schema.Schema.Type<typeof HabitPatch>,
      now: string
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        if (patch.title !== undefined && patch.title.trim().length === 0) {
          return yield* invalid("title", "a habit needs a title")
        }
        const frequency =
          patch.frequency === undefined ? current.frequency : yield* decodeFrequency(patch.frequency)
        const timeZone = patch.timeZone ?? current.timeZone
        const frequencyChanged = !sameHabitFrequency(frequency, current.frequency)
        const history = frequencyChanged
          ? habitFrequencyHistoryAfter({
            history: current.frequencyHistory,
            frequency,
            // The day the change takes effect is the owner's local date in the
            // habit's zone, never the server's UTC date.
            effectiveFrom: localDateIn(now, timeZone)
          })
          : current.frequencyHistory

        // Every field is picked explicitly: a patch that omits a field must
        // keep the stored value, and a spread would write `undefined` over it.
        return new Habit({
          ...current,
          title: patch.title ?? current.title,
          description: patch.description === undefined ? current.description : patch.description,
          color: patch.color === undefined ? current.color : patch.color,
          icon: patch.icon === undefined ? current.icon : patch.icon,
          frequency,
          frequencyHistory: history,
          reminderTime: patch.reminderTime === undefined
            ? current.reminderTime
            : patch.reminderTime,
          timeZone,
          visibility: patch.visibility ?? current.visibility,
          version: current.version + 1,
          updatedAt: now
        })
      })

    /** Are two habits equal in every field the service owns? */
    const sameHabit = (a: Habit, b: Habit): boolean =>
      a.title === b.title &&
      a.description === b.description &&
      a.icon === b.icon &&
      a.color === b.color &&
      a.timeZone === b.timeZone &&
      a.visibility === b.visibility &&
      a.reminderTime === b.reminderTime &&
      sameHabitFrequency(a.frequency, b.frequency) &&
      JSON.stringify(a.frequencyHistory) === JSON.stringify(b.frequencyHistory)

    const update = (
      viewer: HabitViewer,
      input: Schema.Schema.Type<typeof HabitUpdateInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayHabit(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readHabit(viewer, input.id, false)
          const next = yield* patchHabit(current, input.patch, now)
          if (sameHabit(current, next)) return current
          const applied = yield* commitHabit({
            viewer,
            state: habitState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new HabitConflict({ id: input.id }))
      })

    /**
     * Soft delete: the row keeps its identity and history with a `deletedAt`
     * tombstone (the shared trash contract) and the feed records a `delete`
     * op, so the other member's device drops it too.
     */
    const deleteHabit = (
      viewer: HabitViewer,
      input: Schema.Schema.Type<typeof HabitMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayHabit(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readHabit(viewer, input.id, true)
          // Idempotent: deleting an already-deleted habit writes nothing.
          if (current.deletedAt !== null) return current
          const next = new Habit({
            ...current,
            deletedAt: now,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitHabit({
            viewer,
            state: habitState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now,
            op: "delete"
          })
          if (applied) return next
        }
        return yield* Effect.fail(new HabitConflict({ id: input.id }))
      })

    /**
     * Undo a soft delete: clear the tombstone on the same row. The history and
     * the logged entries are untouched, so the habit returns exactly as it was
     * — which is what an undo toast promises.
     */
    const restore = (
      viewer: HabitViewer,
      input: Schema.Schema.Type<typeof HabitMutationInput>,
      now: string = new Date().toISOString()
    ): Effect.Effect<Habit, HabitServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayHabit(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* readHabit(viewer, input.id, true)
          // Idempotent: restoring a live habit writes nothing.
          if (current.deletedAt === null) return current
          const next = new Habit({
            ...current,
            deletedAt: null,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitHabit({
            viewer,
            state: habitState(next),
            expectedVersion: current.version,
            clientMutationId: input.clientMutationId,
            now
          })
          if (applied) return next
        }
        return yield* Effect.fail(new HabitConflict({ id: input.id }))
      })

    const list = (viewer: HabitViewer): Effect.Effect<ReadonlyArray<Habit>, HabitServiceError> =>
      habits
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    return {
      create,
      get,
      update,
      delete: deleteHabit,
      restore,
      list
    } as const
  })
}) {}

export const HabitServiceLive = Layer.effect(HabitService, HabitService.make).pipe(
  Layer.provide(HabitRepoLive),
  Layer.provide(SyncRepoLive)
)
