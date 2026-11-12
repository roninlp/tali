import { Context, Effect, Layer, Option, Schema } from 'effect'
import {
  Habit,
  HabitConflict,
  HabitCreateInput,
  HabitEntry,
  type HabitEntryId,
  HabitEntryLogInput,
  HabitEntryNotFound,
  HabitEntryOutOfWindow,
  HabitEntryRangeInput,
  HabitEntryStatus,
  HabitFrequency,
  HabitForbidden,
  type HabitId,
  type HabitPatch,
  HabitReminderTime,
  HabitValidationError,
  HabitMutationInput,
  HabitNotFound,
  type HabitServiceError,
  HabitUpdateInput,
  type HouseholdId,
  habitFrequencyHistoryAfter,
  habitLogWindow,
  isHabitLogDateInWindow,
  LocalDate,
  localDateIn,
  sameHabitFrequency,
  TimeZone,
  type UserId,
  resolveCreateVisibility,
  uuidV7,
  visibilityDenial,
} from '@tali/domain'
import {
  HabitEntryRepo,
  HabitEntryRepoLive,
  HabitRepo,
  HabitRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
} from '@tali/sql'
import { readScoped } from './row-scope.js'
import { casUpdate } from './cas.js'
import { makeSyncKit } from './sync-write.js'
import { unchangedExcept } from './patch-compare.js'

/**
 * One day of a habit as the log loop sees it: the row to write, and the version
 * to commit it against — `null` when the day has never been logged, which makes
 * the write a gated insert instead of a CAS update.
 */
interface DaySlot {
  readonly row: HabitEntry
  readonly expectedVersion: number | null
}

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
 * A create seeds `startedOn` (the owner's local creation day) and era 0 of
 * `frequencyHistory` on that day. A frequency change appends an era
 * (`habitFrequencyHistoryAfter`) whose boundary is the first period of the new
 * frequency after the period the change happened in has ended — computed from
 * the server's apply instant, never back-dated — so the stats/streak algorithm
 * (#65) can evaluate a past day against the frequency that was in force then.
 * The same helper is used by the offline sync merge, so the two write paths
 * cannot drift.
 *
 * ## Delete is a soft delete, and it is undoable
 *
 * `delete` stamps a `deletedAt` tombstone (the shared 30-day-trash contract) and
 * records a `delete` op on the feed, so the other member's device drops it.
 * `restore` revives the same row — same id, same history, same entries — which
 * is what the undo toast on the habits screen (#66) calls.
 *
 * ## The daily tap (#64)
 *
 * `logEntry` is the service-side tap. It resolves the day's row with
 * `HabitEntryRepo.findForDate` — including a **tombstone** — and writes one
 * gated CAS in the same batch shape as every other mutation. Reviving a
 * tombstoned day therefore happens here, on the service path: the generic
 * `/sync/push` resolver deliberately keeps tombstone-wins (an offline edit
 * must not resurrect a deleted row), so a client whose queued tap meets a
 * tombstone recovers by calling this mutation on the RPC path (the sync engine
 * has an explicit repair hook for that, see
 * `packages/sync-client/src/sync-engine.ts`).
 *
 * The day is validated against the ≤ 7-day backdating window in the viewer's
 * local calendar before anything is written: an out-of-window tap is a typed
 * `HabitEntryOutOfWindow` failure, never a clamped or dropped write.
 *
 * `entries` is the range read (`[from, before)`, own-or-shared visibility) that
 * Today and the statistics (#66) consume.
 */

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
    now?: string,
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly get: (
    viewer: HabitViewer,
    id: Habit['id'],
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly update: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitUpdateInput>,
    now?: string,
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly delete: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitMutationInput>,
    now?: string,
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly restore: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitMutationInput>,
    now?: string,
  ) => Effect.Effect<Habit, HabitServiceError>
  readonly list: (
    viewer: HabitViewer,
  ) => Effect.Effect<ReadonlyArray<Habit>, HabitServiceError>
  /** Log (or re-log) one local day; revives a tombstoned day in place. */
  readonly logEntry: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitEntryLogInput>,
    now?: string,
  ) => Effect.Effect<HabitEntry, HabitServiceError>
  /** The `[from, before)` entries visible to the viewer (Today, stats). */
  readonly entries: (
    viewer: HabitViewer,
    input: Schema.Schema.Type<typeof HabitEntryRangeInput>,
  ) => Effect.Effect<ReadonlyArray<HabitEntry>, HabitServiceError>
}

const invalid = (
  field: string,
  message: string,
): Effect.Effect<never, HabitValidationError> =>
  Effect.fail(new HabitValidationError({ issues: [{ field, message }] }))

export class HabitService extends Context.Service<HabitService>()(
  'HabitService',
  {
    make: Effect.gen(function* () {
      const habits = yield* HabitRepo
      const entries = yield* HabitEntryRepo
      const sync = yield* SyncRepo

      const kit = makeSyncKit<HabitServiceError>({ sync, invalid })

      /**
       * Turn a validated aggregate into the registry's trusted write state. The
       * registration's `validate` boundary is the same one the sync push uses,
       * so a service write can never put a shape on the wire that a pull would
       * reject.
       */
      const habitState = (habit: Habit): SyncEntityState =>
        kit.stateOf('habit', habit)

      /**
       * The entry's trusted write state, validated by the same registry boundary
       * the sync push uses. An entry has no `type` field and no common-item
       * payload: just the day, the status and the scope columns.
       */
      const entryState = (entry: HabitEntry): SyncEntityState =>
        kit.stateOf('habitEntry', entry)

      /** The same row-level scope rules habits use, applied to an entry. */
      const ensureEntryVisible = (
        viewer: HabitViewer,
        entry: HabitEntry,
      ): Effect.Effect<void, HabitForbidden> => {
        const denial = visibilityDenial(entry, viewer)
        if (denial === null) return Effect.void
        // An entry inherits the habit's visibility, so the error names the
        // habit rather than the entry row.
        return Effect.fail(
          new HabitForbidden({ id: entry.habitId, reason: denial }),
        )
      }

      const appliedMutation = (viewer: HabitViewer, clientMutationId: string) =>
        kit.appliedMutation(viewer.householdId, clientMutationId)

      /**
       * Read one habit with the standard scope rules. A tombstone reads as
       * "gone" unless the caller asks for it (the replay/restore guards do).
       */
      const readHabit = (
        viewer: HabitViewer,
        id: HabitId,
        includeTrashed: boolean,
      ): Effect.Effect<Habit, HabitServiceError> =>
        readScoped({
          viewer,
          id,
          find: habits.findById,
          includeTrashed,
          trash: 'last',
          onViolation: violation =>
            violation === 'notFound' || violation === 'trashed'
              ? new HabitNotFound({ id })
              : new HabitForbidden({ id, reason: violation }),
        })

      /** Replay guard: the same mutation id already committed (lost response). */
      const replayHabit = (
        viewer: HabitViewer,
        clientMutationId: string,
        expectedId?: HabitId,
      ): Effect.Effect<Option.Option<Habit>, HabitServiceError> =>
        Effect.gen(function* () {
          const row = yield* appliedMutation(viewer, clientMutationId)
          if (Option.isNone(row)) return Option.none()
          if (
            kit.reusedMutationId(row.value, {
              entityType: 'habit',
              id: expectedId,
            })
          ) {
            return yield* kit.reusedMutationIdError(
              expectedId ?? row.value.entityId,
            )
          }
          // Same household/owner rules as any other read: a mutation id may
          // never hand back another member's private row.
          const current = yield* readHabit(
            viewer,
            row.value.entityId as HabitId,
            true,
          )
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
        frequency: HabitFrequency,
      ): Effect.Effect<HabitFrequency, HabitValidationError> => {
        const decoded = Schema.decodeOption(HabitFrequency)(frequency)
        return decoded._tag === 'Some'
          ? Effect.succeed(decoded.value)
          : invalid('frequency', 'the frequency is not a valid habit rhythm')
      }

      /**
       * Decode the habit's zone and local reminder time. The RPC edge already
       * validates both, but the service is also the boundary for direct callers
       * (tests, future HTTP routes): an invalid zone must be a typed error before
       * any date arithmetic touches `Temporal`, and an invalid `HH:mm` must never
       * reach the model constructor as an unhandled decode failure.
       */
      const decodeTimeZone = (
        timeZone: string,
      ): Effect.Effect<string, HabitValidationError> => {
        const decoded = Schema.decodeOption(TimeZone)(timeZone)
        return decoded._tag === 'Some'
          ? Effect.succeed(decoded.value)
          : invalid('timeZone', 'the time zone must be a valid IANA identifier')
      }

      const decodeReminderTime = (
        value: string | null,
      ): Effect.Effect<string | null, HabitValidationError> => {
        if (value === null) return Effect.succeed(null)
        const decoded = Schema.decodeOption(HabitReminderTime)(value)
        return decoded._tag === 'Some'
          ? Effect.succeed(decoded.value)
          : invalid('reminderTime', 'the reminder time must be a local HH:mm')
      }

      const create = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitCreateInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Habit, HabitServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayHabit(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          if (input.title.trim().length === 0) {
            return yield* invalid('title', 'a habit needs a title')
          }
          const frequency = yield* decodeFrequency(input.frequency)
          const timeZone = yield* decodeTimeZone(
            input.timeZone ?? viewer.timeZone,
          )
          const reminderTime = yield* decodeReminderTime(
            input.reminderTime ?? null,
          )
          // The owner's local creation day: a domain fact, not the UTC instant.
          // Statistics never look before it (#65).
          const startedOn = localDateIn(now, timeZone)

          const habit = new Habit({
            id: (input.id ?? uuidV7()) as Habit['id'],
            type: 'habit',
            title: input.title,
            description: input.description ?? null,
            icon: input.icon ?? null,
            startedOn,
            frequency,
            // Era 0 starts on the habit's first day, in the habit's own zone —
            // the same rule an offline create uses.
            frequencyHistory: [{ effectiveFrom: startedOn, frequency }],
            reminderTime,
            timeZone,
            ownerId: viewer.userId,
            householdId: viewer.householdId,
            visibility: resolveCreateVisibility('habit', input.visibility),
            color: input.color ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            deletedAt: null,
          })

          const applied = yield* kit.commitOne({
            householdId: viewer.householdId,
            state: habitState(habit),
            expectedVersion: null,
            clientMutationId: input.clientMutationId,
            now,
          })
          if (!applied) {
            return yield* new HabitConflict({ id: habit.id })
          }
          return habit
        })

      const get = (
        viewer: HabitViewer,
        id: Habit['id'],
      ): Effect.Effect<Habit, HabitServiceError> => readHabit(viewer, id, false)

      /** Apply a patch to a row, versioning the frequency when it changes. */
      const patchHabit = (
        viewer: HabitViewer,
        current: Habit,
        patch: Schema.Schema.Type<typeof HabitPatch>,
        now: string,
      ): Effect.Effect<Habit, HabitServiceError> =>
        Effect.gen(function* () {
          if (patch.title !== undefined && patch.title.trim().length === 0) {
            return yield* invalid('title', 'a habit needs a title')
          }
          // Only the creator can flip a shared habit to private; the other member
          // must not be able to lock the owner out of their own habit (the same
          // rule lists apply).
          if (
            patch.visibility === 'private' &&
            current.ownerId !== viewer.userId
          ) {
            return yield* invalid(
              'visibility',
              'only the habit owner can make it private',
            )
          }
          const frequency =
            patch.frequency === undefined
              ? current.frequency
              : yield* decodeFrequency(patch.frequency)
          const timeZone = yield* decodeTimeZone(
            patch.timeZone ?? current.timeZone,
          )
          const reminderTime =
            patch.reminderTime === undefined
              ? current.reminderTime
              : yield* decodeReminderTime(patch.reminderTime)
          const frequencyChanged = !sameHabitFrequency(
            frequency,
            current.frequency,
          )
          const history = frequencyChanged
            ? habitFrequencyHistoryAfter({
                history: current.frequencyHistory,
                frequency,
                // The era boundary is computed from the instant this change is
                // applied, in the habit's zone — never a client-supplied edit day,
                // so a frequency change can never be back-dated ahead of the era it
                // replaces (#65).
                changeDate: localDateIn(now, timeZone),
              })
            : current.frequencyHistory

          // Every field is picked explicitly: a patch that omits a field must
          // keep the stored value, and a spread would write `undefined` over it.
          return new Habit({
            ...current,
            title: patch.title ?? current.title,
            description:
              patch.description === undefined
                ? current.description
                : patch.description,
            color: patch.color === undefined ? current.color : patch.color,
            icon: patch.icon === undefined ? current.icon : patch.icon,
            frequency,
            frequencyHistory: history,
            reminderTime,
            timeZone,
            visibility: patch.visibility ?? current.visibility,
            version: current.version + 1,
            updatedAt: now,
          })
        })

      const update = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitUpdateInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Habit, HabitServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayHabit(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          return yield* casUpdate({
            read: readHabit(viewer, input.id, false),
            plan: current =>
              Effect.gen(function* () {
                const next = yield* patchHabit(
                  viewer,
                  current,
                  input.patch,
                  now,
                )
                // `patchHabit` writes patch fields only (`frequencyHistory` is
                // derived from `frequency`), so the patch is the no-op test —
                // except `frequency`, whose weekdays are a *set*: the domain's
                // canonical comparison keeps a reordered selection from
                // minting a phantom version. Nothing is dropped by that split:
                // an omitted `frequency` leaves the history untouched, and a
                // different one always writes.
                const { frequency, ...rest } = input.patch
                const frequencySame =
                  frequency === undefined ||
                  sameHabitFrequency(current.frequency, next.frequency)
                return frequencySame && unchangedExcept(current, next, rest)
                  ? null
                  : next
              }),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: habitState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
              }),
            conflict: () => new HabitConflict({ id: input.id }),
          })
        })

      /**
       * Soft delete: the row keeps its identity and history with a `deletedAt`
       * tombstone (the shared trash contract) and the feed records a `delete`
       * op, so the other member's device drops it too.
       */
      const deleteHabit = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitMutationInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Habit, HabitServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayHabit(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          return yield* casUpdate({
            read: readHabit(viewer, input.id, true),
            // Idempotent: deleting an already-deleted habit writes nothing.
            plan: current =>
              Effect.succeed(
                current.deletedAt !== null
                  ? null
                  : new Habit({
                      ...current,
                      deletedAt: now,
                      version: current.version + 1,
                      updatedAt: now,
                    }),
              ),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: habitState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
                op: 'delete',
              }),
            conflict: () => new HabitConflict({ id: input.id }),
          })
        })

      /**
       * Undo a soft delete: clear the tombstone on the same row. The history and
       * the logged entries are untouched, so the habit returns exactly as it was
       * — which is what an undo toast promises.
       */
      const restore = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitMutationInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<Habit, HabitServiceError> =>
        Effect.gen(function* () {
          const replayed = yield* replayHabit(
            viewer,
            input.clientMutationId,
            input.id,
          )
          if (Option.isSome(replayed)) return replayed.value

          return yield* casUpdate({
            read: readHabit(viewer, input.id, true),
            // Idempotent: restoring a live habit writes nothing.
            plan: current =>
              Effect.succeed(
                current.deletedAt === null
                  ? null
                  : new Habit({
                      ...current,
                      deletedAt: null,
                      version: current.version + 1,
                      updatedAt: now,
                    }),
              ),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: habitState(next),
                expectedVersion: current.version,
                clientMutationId: input.clientMutationId,
                now,
              }),
            conflict: () => new HabitConflict({ id: input.id }),
          })
        })

      const list = (
        viewer: HabitViewer,
      ): Effect.Effect<ReadonlyArray<Habit>, HabitServiceError> =>
        habits
          .listVisible({
            householdId: viewer.householdId,
            userId: viewer.userId,
          })
          .pipe(Effect.orDie)

      /**
       * Log one local day (#64; FR-HAB-02).
       *
       * The row is keyed by `(habitId, localDate)` for all time, so this is an
       * upsert against the day rather than against an id: an existing live row is
       * CAS-updated, a tombstoned row is revived **in place** (same id, same
       * creation time, same owner), and only a day that has never been logged
       * inserts. A racing insert loses the unique index and surfaces as a no-op
       * (`ON CONFLICT DO NOTHING`), then this loop re-reads the day and updates
       * the winning row — never a duplicate.
       */
      const logEntry = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitEntryLogInput>,
        now: string = new Date().toISOString(),
      ): Effect.Effect<HabitEntry, HabitServiceError> =>
        Effect.gen(function* () {
          // Replay guard: a retry after a lost response returns the row it wrote.
          const replayed = yield* appliedMutation(
            viewer,
            input.clientMutationId,
          )
          if (Option.isSome(replayed)) {
            if (
              kit.reusedMutationId(replayed.value, {
                entityType: 'habitEntry',
                id: input.id,
              })
            ) {
              return yield* kit.reusedMutationIdError(
                input.id ?? replayed.value.entityId,
              )
            }
            const found = yield* entries
              .findById(replayed.value.entityId as HabitEntryId)
              .pipe(Effect.orDie)
            if (Option.isNone(found)) {
              return yield* new HabitEntryNotFound({
                id: replayed.value.entityId as HabitEntryId,
              })
            }
            // A mutation id is one day's log. When the caller minted no id (the
            // usual service path), the id guard above cannot tell a reused id
            // from a replay, so the resolved row is checked against the request:
            // a mutation id reused for another habit or day is refused instead of
            // silently handing back the wrong row.
            if (
              found.value.habitId !== input.habitId ||
              found.value.localDate !== input.localDate
            ) {
              return yield* kit.reusedMutationIdError(found.value.id)
            }
            yield* ensureEntryVisible(viewer, found.value)
            return found.value
          }

          const status = Schema.decodeOption(HabitEntryStatus)(input.status)
          if (status._tag === 'None') {
            return yield* invalid(
              'status',
              'a logged day is done, partial or missed',
            )
          }
          const localDate = Schema.decodeOption(LocalDate)(input.localDate)
          if (localDate._tag === 'None') {
            return yield* invalid(
              'localDate',
              'the logged day must be a calendar date',
            )
          }
          const timeZone = yield* decodeTimeZone(
            input.timeZone ?? viewer.timeZone,
          )

          // The window is the viewer's local calendar: "yesterday" is the day
          // they experienced, not a UTC instant. It is checked before any read or
          // write, so an old day can never be silently clamped to today. The
          // boundary is the same pure helper the client tap uses, so the two
          // cannot drift.
          const today = localDateIn(now, viewer.timeZone)
          if (!isHabitLogDateInWindow(localDate.value, today)) {
            const window = habitLogWindow(today)
            return yield* new HabitEntryOutOfWindow({
              localDate: localDate.value,
              earliest: window.earliest,
              latest: window.latest,
            })
          }

          // Scope: the habit must exist, be visible and not be in the trash. A
          // tap can never log against another household's or another member's
          // private habit.
          const habit = yield* readHabit(viewer, input.habitId, false)

          // A day that was never logged has no row to CAS yet, so the read
          // yields the draft this attempt would insert (`expectedVersion: null`)
          // and the gated insert shares the loop with the revive-in-place. A
          // racing insert loses the unique `(habitId, localDate)` index, which
          // surfaces as a no-op and makes the next attempt update the winner.
          const logged = yield* casUpdate<DaySlot, HabitServiceError>({
            read: entries
              .findForDate({ habitId: habit.id, localDate: localDate.value })
              .pipe(
                Effect.orDie,
                Effect.map((found): DaySlot =>
                  Option.isSome(found)
                    ? { row: found.value, expectedVersion: found.value.version }
                    : {
                        row: new HabitEntry({
                          id: (input.id ?? uuidV7()) as HabitEntry['id'],
                          habitId: habit.id,
                          ownerId: viewer.userId,
                          householdId: viewer.householdId,
                          visibility: habit.visibility,
                          localDate: localDate.value,
                          timeZone,
                          status: status.value,
                          createdAt: now,
                          updatedAt: now,
                          version: 1,
                          deletedAt: null,
                        }),
                        expectedVersion: null,
                      },
                ),
              ),
            plan: current =>
              Effect.sync((): DaySlot | null => {
                // Authorisation comes from the habit (`readHabit` above), not
                // from the entry's denormalised visibility: if a habit was
                // flipped to shared, the partner may log its days even when an
                // older row was written while it was private. The write below
                // re-inherits the habit's visibility, so the row converges.
                if (current.expectedVersion === null) return current
                // An identical tap changes nothing: return the stored row
                // rather than growing the feed with a no-op version.
                if (
                  current.row.deletedAt === null &&
                  current.row.status === status.value &&
                  current.row.timeZone === timeZone &&
                  current.row.visibility === habit.visibility
                ) {
                  return null
                }
                return {
                  // Revive in place: the day's identity never changes, so the
                  // other device's mirror/queue still points at the same row.
                  row: new HabitEntry({
                    ...current.row,
                    visibility: habit.visibility,
                    timeZone,
                    status: status.value,
                    version: current.row.version + 1,
                    updatedAt: now,
                    deletedAt: null,
                  }),
                  expectedVersion: current.expectedVersion,
                }
              }),
            write: (current, next) =>
              kit.commitOne({
                householdId: viewer.householdId,
                state: entryState(next.row),
                expectedVersion: next.expectedVersion,
                clientMutationId: input.clientMutationId,
                now,
              }),
            conflict: () => new HabitConflict({ id: habit.id }),
          })

          return logged.row
        })

      /**
       * The half-open `[from, before)` range read (#64).
       *
       * It is deliberately independent of the habit list: Today renders the
       * viewer's own days and the days of shared habits, which is exactly the
       * repository's scope filter (`owner_id = viewer OR shared`). A tombstone is
       * not a log entry, so deleted days are absent.
       */
      const entriesInRange = (
        viewer: HabitViewer,
        input: Schema.Schema.Type<typeof HabitEntryRangeInput>,
      ): Effect.Effect<ReadonlyArray<HabitEntry>, HabitServiceError> =>
        Effect.gen(function* () {
          const from = Schema.decodeOption(LocalDate)(input.from)
          if (from._tag === 'None') {
            return yield* invalid(
              'from',
              'the range must start on a calendar date',
            )
          }
          const before = Schema.decodeOption(LocalDate)(input.before)
          if (before._tag === 'None') {
            return yield* invalid(
              'before',
              'the range must end on a calendar date',
            )
          }
          if (from.value >= before.value) {
            return yield* invalid(
              'before',
              'the range must end after it starts',
            )
          }
          return yield* entries
            .listInRange({
              householdId: viewer.householdId,
              userId: viewer.userId,
              from: from.value,
              before: before.value,
              habitId: input.habitId,
            })
            .pipe(Effect.orDie)
        })

      return {
        create,
        get,
        update,
        delete: deleteHabit,
        restore,
        list,
        logEntry,
        entries: entriesInRange,
      } as const
    }),
  },
) {}

export const HabitServiceLive = Layer.effect(
  HabitService,
  HabitService.make,
).pipe(
  Layer.provide(HabitRepoLive),
  Layer.provide(HabitEntryRepoLive),
  Layer.provide(SyncRepoLive),
)
