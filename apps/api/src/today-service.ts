import { Context, Effect, Layer } from "effect"
import {
  type DashboardSectionOrder,
  type HouseholdId,
  type Note,
  taskBucketBounds,
  TodayReadModel,
  type Task,
  type UserId
} from "@tali/domain"
import { NoteService, NoteServiceLive } from "./note-service.js"
import { TaskService, TaskServiceLive } from "./task-service.js"

/**
 * `TodayService` — the one aggregated read behind `GET /today` (ticket #42).
 *
 * This is a composition, not a second source of truth: tasks come from
 * `TaskService.buckets` (#36) and pinned notes from `NoteService.listPinned`
 * (#40), so the dashboard inherits their household scoping and private-item
 * authorization exactly. The daily picture is the overdue bucket followed by
 * today's bucket; no-date and future tasks never enter Today (FR-TASK-05).
 *
 * Events, reminders and habits are represented as empty sections on purpose.
 * Their aggregates arrive with Slices 3–4; faking counts here would make the
 * dashboard lie about data the product cannot yet read.
 */

export interface TodayViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  readonly timeZone: string
}

export interface TodayServiceApi {
  readonly get: (
    viewer: TodayViewer,
    sectionOrder: DashboardSectionOrder,
    now?: string
  ) => Effect.Effect<TodayReadModel, never>
}

export class TodayService extends Context.Service<TodayService>()("TodayService", {
  make: Effect.gen(function*() {
    const taskService = yield* TaskService
    const noteService = yield* NoteService

    const get = (
      viewer: TodayViewer,
      sectionOrder: DashboardSectionOrder,
      now: string = new Date().toISOString()
    ): Effect.Effect<TodayReadModel, never> =>
      Effect.gen(function*() {
        const bounds = taskBucketBounds(viewer.timeZone, now)
        // Buckets and pinned notes are independent reads. Fan them out
        // instead of stacking their D1 round trips. Peak concurrency is 5:
        // buckets caps itself at 4, and the pinned-notes query adds one, which
        // stays inside Workers' ~6 simultaneous outgoing connections.
        const [buckets, notes] = yield* Effect.all(
          [
            taskService.buckets(
              {
                userId: viewer.userId,
                householdId: viewer.householdId,
                timeZone: viewer.timeZone
              },
              now
            ),
            noteService.listPinned({
              userId: viewer.userId,
              householdId: viewer.householdId
            })
          ],
          { concurrency: 4 }
        )

        const tasks: ReadonlyArray<Task> = [...buckets.overdue, ...buckets.todayTasks]
        return {
          today: bounds.today,
          tomorrow: bounds.tomorrow,
          timeZone: viewer.timeZone,
          sectionOrder,
          tasks,
          notes: notes as ReadonlyArray<Note>,
          counts: {
            tasks: tasks.length,
            overdue: buckets.overdue.length,
            events: 0,
            reminders: 0,
            habits: 0,
            notes: notes.length
          },
          empty: {
            tasks: tasks.length === 0,
            // Quiet until their slices land; the section is known, not filled.
            events: true,
            reminders: true,
            habits: true,
            notes: notes.length === 0
          }
        }
      }).pipe(Effect.orDie)
    // The read path only touches repositories, whose failures are defects by
    // design (the same convention as `TaskService` reads). Typed errors on the
    // route are therefore auth-only.

    return { get } as const
  })
}) {}

export const TodayServiceLive = Layer.effect(TodayService, TodayService.make).pipe(
  Layer.provide(TaskServiceLive),
  Layer.provide(NoteServiceLive)
)
