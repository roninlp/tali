import { Context, Effect, Layer } from "effect"
import {
  buildMonthReadModel,
  buildWeekReadModel,
  jalaliMonthOf,
  localDateStartInstant,
  monthRange,
  singleDayRange,
  taskBucketBounds,
  weekRange,
  type CalendarEventSource,
  type CalendarOccasionSource,
  type CalendarRange,
  type CalendarTaskSource,
  type HouseholdId,
  type LocalDate,
  type MonthReadModel,
  type Task,
  type UserId,
  type WeekReadModel,
  type WeekStart
} from "@tali/domain"
import {
  EventRepo,
  EventRepoLive,
  OccasionRepo,
  OccasionRepoLive,
  TaskRepo,
  TaskRepoLive
} from "@tali/sql"

/**
 * `CalendarService` — the week and month read models (ticket #43;
 * FR-VIEW-02/03).
 *
 * This is a composition over `TaskRepo`, not a second source of truth:
 *
 * 1. Read the live tasks whose due day/instant falls inside the calendar
 *    range (two indexed range queries, the same zoned day-start boundaries the
 *    #36 buckets use).
 * 2. Read the live recurring rows once, because a series' anchor may sit
 *    before the range while its projected occurrences fall inside it.
 * 3. Hand both to the shared `packages/domain` builders, which expand the #38
 *    recurrence engine and mark generated occurrences read-only.
 *
 * The repository's `visibleScope` already applies household + private-item
 * authorization, so a viewer can never see another member's private task in a
 * week or month grid. Done rows are excluded: the calendar is about the work
 * still to plan.
 *
 * Since #58 the event lane is real, with the same three steps: the events
 * anchored inside the range plus every live recurring series, expanded by the
 * pure `eventOccurrences` builder (which reuses the same #38 engine and marks
 * generated occurrences read-only). Ticket #62 adds the occasion lane: every
 * visible occasion row is projected into the range by the annual builder #59
 * ships (`occasionOccurrences`), so a birthday paints on its Jalali date in
 * the same grid as tasks and events.
 *
 * Reminder and habit lanes stay honest zeros until their screens land; the
 * read-model shape reserves them so no client code has to change later.
 */

export interface CalendarViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  readonly timeZone: string
  readonly weekStart: WeekStart
}

export interface MonthViewOptions {
  /** Any date in the Jalali month to show; defaults to the viewer's today. */
  readonly anchor?: LocalDate
  /** Optional day drill-down. */
  readonly day?: LocalDate | null
}

export interface CalendarServiceApi {
  readonly week: (
    viewer: CalendarViewer,
    anchor?: LocalDate,
    now?: string
  ) => Effect.Effect<WeekReadModel, never>
  readonly month: (
    viewer: CalendarViewer,
    options?: MonthViewOptions,
    now?: string
  ) => Effect.Effect<MonthReadModel, never>
}

export class CalendarService extends Context.Service<CalendarService>()(
  "CalendarService",
  {
    make: Effect.gen(function*() {
      const tasks = yield* TaskRepo
      const events = yield* EventRepo
      const occasions = yield* OccasionRepo

      /**
       * The rows a range needs: tasks due inside it plus live recurring rows.
       * Merged by id because a recurring row can satisfy both queries.
       */
      const loadRangeTasks = (
        viewer: CalendarViewer,
        range: CalendarRange
      ): Effect.Effect<ReadonlyArray<CalendarTaskSource>> =>
        Effect.gen(function*() {
          const scope = {
            householdId: viewer.householdId,
            userId: viewer.userId
          }
          const from = localDateStartInstant(range.start, viewer.timeZone)
          const before = localDateStartInstant(range.endExclusive, viewer.timeZone)

          const allDay = yield* tasks
            .listDueDateRange({ ...scope, from: range.start, before: range.endExclusive })
            .pipe(Effect.orDie)
          const timed = yield* tasks
            .listDueInstantRange({ ...scope, from, before })
            .pipe(Effect.orDie)
          const recurring = yield* tasks.listRecurringLive(scope).pipe(Effect.orDie)

          const byId = new Map<string, Task>()
          for (const task of [...allDay, ...timed, ...recurring]) {
            byId.set(task.id, task)
          }
          return [...byId.values()]
        })

      /**
       * The events a range needs: the rows anchored inside it plus every live
       * recurring series (a series anchored months earlier still has
       * occurrences inside the window). Merged by id because a recurring row
       * can satisfy both queries.
       */
      const loadRangeEvents = (
        viewer: CalendarViewer,
        range: CalendarRange
      ): Effect.Effect<ReadonlyArray<CalendarEventSource>> =>
        Effect.gen(function*() {
          const scope = {
            householdId: viewer.householdId,
            userId: viewer.userId
          }
          const inRange = yield* events
            .listInRange({
              ...scope,
              dateFrom: range.start,
              dateBefore: range.endExclusive,
              instantFrom: localDateStartInstant(range.start, viewer.timeZone),
              instantBefore: localDateStartInstant(range.endExclusive, viewer.timeZone)
            })
            .pipe(Effect.orDie)
          const recurring = yield* events.listRecurringLive(scope).pipe(Effect.orDie)

          const byId = new Map<string, CalendarEventSource>()
          for (const event of [...inRange, ...recurring]) byId.set(event.id, event)
          return [...byId.values()]
        })

      /**
       * Every occasion visible to the viewer. An occasion is an annual date
       * derived from its origin, so there is no range query to run: the same
       * rows project onto any window (#59), and the set is small.
       */
      const loadOccasions = (
        viewer: CalendarViewer
      ): Effect.Effect<ReadonlyArray<CalendarOccasionSource>> =>
        occasions
          .listVisible({
            householdId: viewer.householdId,
            userId: viewer.userId
          })
          .pipe(Effect.orDie)

      const week = (
        viewer: CalendarViewer,
        anchor?: LocalDate,
        now: string = new Date().toISOString()
      ): Effect.Effect<WeekReadModel, never> =>
        Effect.gen(function*() {
          const date = anchor ?? taskBucketBounds(viewer.timeZone, now).today
          const range = weekRange(date, viewer.weekStart)
          const rows = yield* loadRangeTasks(viewer, range)
          const eventRows = yield* loadRangeEvents(viewer, range)
          const occasionRows = yield* loadOccasions(viewer)
          return buildWeekReadModel({
            tasks: rows,
            events: eventRows,
            occasions: occasionRows,
            anchor: date,
            weekStart: viewer.weekStart,
            timeZone: viewer.timeZone
          })
        }).pipe(Effect.orDie)

      const month = (
        viewer: CalendarViewer,
        options: MonthViewOptions = {},
        now: string = new Date().toISOString()
      ): Effect.Effect<MonthReadModel, never> =>
        Effect.gen(function*() {
          const anchor = options.anchor ?? taskBucketBounds(viewer.timeZone, now).today
          const { year, month: monthOfYear } = jalaliMonthOf(anchor)
          const range = monthRange(year, monthOfYear, viewer.weekStart)
          const day = options.day ?? null
          const rows = yield* loadRangeTasks(viewer, range)
          const eventRows = yield* loadRangeEvents(viewer, range)
          // The drill-down accepts any date, and a client may ask for one
          // outside the month grid (a stale selection, an adjacent-month day).
          // The grid query never covered it, so read that day too instead of
          // answering an empty day for a day that has tasks.
          let drillRows: ReadonlyArray<CalendarTaskSource> = []
          let drillEvents: ReadonlyArray<CalendarEventSource> = []
          if (day !== null && (day < range.start || day > range.end)) {
            const drillRange = singleDayRange(day)
            drillRows = yield* loadRangeTasks(viewer, drillRange)
            drillEvents = yield* loadRangeEvents(viewer, drillRange)
          }
          const occasionRows = yield* loadOccasions(viewer)
          return buildMonthReadModel({
            tasks: [...rows, ...drillRows],
            events: [...eventRows, ...drillEvents],
            occasions: occasionRows,
            year,
            month: monthOfYear,
            weekStart: viewer.weekStart,
            timeZone: viewer.timeZone,
            day
          })
        }).pipe(Effect.orDie)

      return { week, month } as const
    })
  }
) {}

export const CalendarServiceLive = Layer.effect(
  CalendarService,
  CalendarService.make
).pipe(
  Layer.provide(TaskRepoLive),
  Layer.provide(EventRepoLive),
  Layer.provide(OccasionRepoLive)
)
