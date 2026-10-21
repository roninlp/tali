import { Effect } from "effect"
import type { Headers } from "effect/http/Headers"
import { ApiRpcs } from "@tali/rpc"
import {
  EventForbidden,
  HabitForbidden,
  ListForbidden,
  ReminderForbidden,
  NoteForbidden,
  TaskForbidden,
  Unauthorized
} from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { EventService, type EventViewer } from "./event-service.js"
import { HabitService, type HabitViewer } from "./habit-service.js"
import { ListService, type ListViewer } from "./list-service.js"
import { NoteService } from "./note-service.js"
import { PreferencesService } from "./preferences-service.js"
import { ReminderService, type ReminderViewer } from "./reminder-service.js"
import { TaskService, type TaskViewer } from "./task-service.js"
import { SESSION_COOKIE } from "./auth-routes.js"

/**
 * The RPC handler map (ticket #36).
 *
 * Auth rides the raw HTTP request headers: Effect's RPC server merges the
 * request headers into every handler's `options.headers`, so the session
 * cookie is available exactly as it is on the plain-HTTP routes. The viewer is
 * derived server-side — a payload can never choose its user or household — and
 * carries the preferences time zone (falling back to the profile's zone) so
 * buckets are computed in the user's wall clock.
 */

const cookieToken = (cookie: string | undefined): string | undefined => {
  if (cookie === undefined) return undefined
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE) return rest.join("=")
  }
  return undefined
}

export const viewerFromHeaders = (
  headers: Headers
): Effect.Effect<TaskViewer, Unauthorized | TaskForbidden, AuthService | PreferencesService> =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const preferences = yield* PreferencesService
    const token = cookieToken(headers["cookie"])
    if (token === undefined) {
      return yield* Effect.fail(new Unauthorized())
    }
    const context = yield* auth.me(token)
    if (context.householdId === null) {
      return yield* Effect.fail(new TaskForbidden({ id: null, reason: "noHousehold" }))
    }
    const prefs = yield* preferences.get(context.user.id, {
      timeZone: context.user.timeZone,
      weekStart: context.user.weekStart,
      digits: context.user.digits
    })
    return {
      userId: context.user.id,
      householdId: context.householdId,
      timeZone: prefs.timeZone,
      defaultCheckedPlacement: prefs.checkedItemPlacement
    } as const
  })

const withViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: TaskViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | TaskForbidden, AuthService | PreferencesService | R> =>
  Effect.gen(function*() {
    const viewer = yield* viewerFromHeaders(headers)
    return yield* run(viewer)
  })

/**
 * Notes have their own typed forbidden error, so the edge's "no household"
 * failure is mapped into `NoteForbidden` before the handler runs. This keeps
 * each aggregate's wire union self-contained instead of leaking a task-named
 * tag into the note contract.
 */
const withNoteViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: TaskViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | NoteForbidden, AuthService | PreferencesService | R> =>
  viewerFromHeaders(headers).pipe(
    Effect.mapError((error) =>
      error._tag === "TaskForbidden"
        ? new NoteForbidden({ id: error.id, reason: error.reason })
        : error
    ),
    Effect.flatMap(run)
  )

/**
 * Lists have their own typed forbidden error, so the edge's "no household"
 * failure is mapped before the handler runs (same pattern as notes).
 */
const withListViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: ListViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | ListForbidden, AuthService | PreferencesService | R> =>
  viewerFromHeaders(headers).pipe(
    Effect.mapError((error) =>
      error._tag === "TaskForbidden"
        ? new ListForbidden({ id: error.id, reason: error.reason })
        : error
    ),
    Effect.flatMap(run)
  )

/**
 * Events have their own typed forbidden error, so the edge's "no household"
 * failure is mapped before the handler runs (same pattern as notes/lists).
 */
const withEventViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: EventViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | EventForbidden, AuthService | PreferencesService | R> =>
  viewerFromHeaders(headers).pipe(
    Effect.mapError((error) =>
      error._tag === "TaskForbidden"
        ? new EventForbidden({ id: error.id, reason: error.reason })
        : error
    ),
    Effect.flatMap(run)
  )

/**
 * Habits have their own typed forbidden error, so the edge's "no household"
 * failure is mapped before the handler runs (same pattern as notes/lists/events).
 */
const withHabitViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: HabitViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | HabitForbidden, AuthService | PreferencesService | R> =>
  viewerFromHeaders(headers).pipe(
    Effect.mapError((error) =>
      error._tag === "TaskForbidden"
        ? new HabitForbidden({ id: error.id, reason: error.reason })
        : error
    ),
    Effect.flatMap(run)
  )

/**
 * Reminders have their own typed forbidden error (same pattern as notes,
 * lists and events), so the edge's "no household" failure is mapped before
 * the handler runs.
 */
const withReminderViewer = <A, E, R>(
  headers: Headers,
  run: (viewer: ReminderViewer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Unauthorized | ReminderForbidden, AuthService | PreferencesService | R> =>
  viewerFromHeaders(headers).pipe(
    Effect.mapError((error) =>
      error._tag === "TaskForbidden"
        ? new ReminderForbidden({ id: error.id, reason: error.reason })
        : error
    ),
    Effect.flatMap(run)
  )

export const RpcHandlers = ApiRpcs.toLayer({
  CreateList: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetList: ({ id }, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  UpdateList: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  DeleteList: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.remove(viewer, input)))),
  ListLists: (_input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.list(viewer)))),

  CreateListItem: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.createItem(viewer, input)))),
  AppendListItems: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.appendItems(viewer, input)))),
  ListListItems: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.listItems(viewer, input)))),
  UpdateListItem: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.updateItem(viewer, input)))),
  SetListItemChecked: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.setItemChecked(viewer, input)))),
  DeleteListItem: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.deleteItem(viewer, input)))),
  ReorderListItems: (input, { headers }) =>
    withListViewer(headers, (viewer) =>
      ListService.pipe(Effect.flatMap((svc) => svc.reorder(viewer, input)))),

  CreateTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetTask: ({ id }, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  UpdateTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  MoveTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.move(viewer, input)))),
  StartTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.start(viewer, input)))),
  CompleteTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.complete(viewer, input)))),
  UndoTask: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.undo(viewer, input)))),
  ListTasks: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.list(viewer, input)))),
  GetTaskBuckets: (_input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.buckets(viewer)))),

  CreateProject: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.createProject(viewer, input)))),
  RenameProject: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.renameProject(viewer, input)))),
  ListProjects: (_input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.listProjects(viewer)))),

  CreateTag: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.createTag(viewer, input)))),
  RenameTag: (input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.renameTag(viewer, input)))),
  ListTags: (_input, { headers }) =>
    withViewer(headers, (viewer) =>
      TaskService.pipe(Effect.flatMap((svc) => svc.listTags(viewer)))),

  // ── Notes ─────────────────────────────────────────────────────────────

  CreateNote: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetNote: ({ id }, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  SaveNote: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.save(viewer, input)))),
  UpdateNote: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  SetNotePinned: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.setPinned(viewer, input)))),
  SetNoteArchived: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.setArchived(viewer, input)))),
  SetNoteTags: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.setTags(viewer, input)))),
  TrashNote: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.trash(viewer, input)))),
  RestoreNote: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.restore(viewer, input)))),
  ListNotes: (input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.list(viewer, input)))),
  ListPinnedNotes: (_input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.listPinned(viewer)))),
  ListTrashNotes: (_input, { headers }) =>
    withNoteViewer(headers, (viewer) =>
      NoteService.pipe(Effect.flatMap((svc) => svc.listTrash(viewer)))),

  // ── Events ────────────────────────────────────────────────────────────

  CreateEvent: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetEvent: ({ id }, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  UpdateEvent: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  DeleteEvent: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.delete(viewer, input)))),
  ListEvents: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.list(viewer, input)))),
  ListEventOccurrences: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.occurrences(viewer, input)))),
  EditEventOccurrence: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.editOccurrence(viewer, input)))),
  DeleteEventOccurrence: (input, { headers }) =>
    withEventViewer(headers, (viewer) =>
      EventService.pipe(Effect.flatMap((svc) => svc.deleteOccurrence(viewer, input)))),

  // ── Habits ────────────────────────────────────────────────────────────

  CreateHabit: (input, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetHabit: ({ id }, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  UpdateHabit: (input, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  DeleteHabit: (input, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.delete(viewer, input)))),
  RestoreHabit: (input, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.restore(viewer, input)))),
  ListHabits: (_input, { headers }) =>
    withHabitViewer(headers, (viewer) =>
      HabitService.pipe(Effect.flatMap((svc) => svc.list(viewer))))
,

  // ── Reminders ──────────────────────────────────────────────────────────
  CreateReminder: (input, { headers }) =>
    withReminderViewer(headers, (viewer) =>
      ReminderService.pipe(Effect.flatMap((svc) => svc.create(viewer, input)))),
  GetReminder: ({ id }, { headers }) =>
    withReminderViewer(headers, (viewer) =>
      ReminderService.pipe(Effect.flatMap((svc) => svc.get(viewer, id)))),
  UpdateReminder: (input, { headers }) =>
    withReminderViewer(headers, (viewer) =>
      ReminderService.pipe(Effect.flatMap((svc) => svc.update(viewer, input)))),
  DeleteReminder: (input, { headers }) =>
    withReminderViewer(headers, (viewer) =>
      ReminderService.pipe(Effect.flatMap((svc) => svc.delete(viewer, input)))),
  ListReminders: (input, { headers }) =>
    withReminderViewer(headers, (viewer) =>
      ReminderService.pipe(Effect.flatMap((svc) => svc.list(viewer, input))))
})
