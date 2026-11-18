import { Effect } from 'effect'
import type { Headers } from 'effect/http/Headers'
import { ApiRpcs } from '@tali/rpc'
import {
  CaptureForbidden,
  EventForbidden,
  type ForbiddenReason,
  HabitForbidden,
  ListForbidden,
  ReminderForbidden,
  NoteForbidden,
  OccasionForbidden,
  TaskForbidden,
  Unauthorized,
  type WeekStart,
} from '@tali/domain'
import type { AuthService } from './auth-service.js'
import { CaptureService } from './capture-service.js'
import { EventService } from './event-service.js'
import { HabitService } from './habit-service.js'
import { SESSION_COOKIE } from './http-envelope.js'
import { ListService } from './list-service.js'
import { NoteService } from './note-service.js'
import { OccasionService } from './occasion-service.js'
import type { PreferencesService } from './preferences-service.js'
import {
  type NoHousehold,
  principalFromToken,
  requireHousehold,
} from './principal.js'
import { ReminderService } from './reminder-service.js'
import { TaskService, type TaskViewer } from './task-service.js'

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
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=')
  }
  return undefined
}

/**
 * The edge always resolves `weekStart` from the stored preferences, so it can
 * promise what the service-level `TaskViewer` leaves optional.
 */
type RpcViewer = TaskViewer & { readonly weekStart: WeekStart }

export const viewerFromHeaders = (
  headers: Headers,
): Effect.Effect<
  RpcViewer,
  Unauthorized | NoHousehold,
  AuthService | PreferencesService
> =>
  Effect.gen(function* () {
    const token = cookieToken(headers['cookie'])
    if (token === undefined) {
      return yield* new Unauthorized()
    }
    const { context, preferences } = yield* principalFromToken(token)
    const householdId = yield* requireHousehold(context)
    return {
      userId: context.user.id,
      householdId,
      timeZone: preferences.timeZone,
      weekStart: preferences.weekStart,
      defaultCheckedPlacement: preferences.checkedItemPlacement,
    }
  })

/**
 * Resolve the viewer, then run the handler.
 *
 * The guard is minted once (`requireHousehold` inside `viewerFromHeaders`),
 * and this is the single place its `NoHousehold` verdict becomes an RPC
 * failure: translated into the aggregate's own forbidden tag, so a task-named
 * error never leaks into another contract. A forbidden error raised by the
 * handler itself — a real scope denial — passes through untouched.
 */
const withViewer = <A, E, R, F>(
  headers: Headers,
  forbidden: (reason: ForbiddenReason) => F,
  run: (viewer: RpcViewer) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | F | Unauthorized,
  AuthService | PreferencesService | R
> =>
  viewerFromHeaders(headers).pipe(
    Effect.catchTag('NoHousehold', () => Effect.fail(forbidden('noHousehold'))),
    Effect.flatMap(run),
  )

/**
 * The per-aggregate forbidden constructors the edge translates the one
 * `NoHousehold` verdict into. Capture's refusal addresses no row, so it is
 * the one forbidden error that carries no `id`.
 */
const taskForbidden = (reason: ForbiddenReason) =>
  new TaskForbidden({ id: null, reason })
const noteForbidden = (reason: ForbiddenReason) =>
  new NoteForbidden({ id: null, reason })
const listForbidden = (reason: ForbiddenReason) =>
  new ListForbidden({ id: null, reason })
const eventForbidden = (reason: ForbiddenReason) =>
  new EventForbidden({ id: null, reason })
const habitForbidden = (reason: ForbiddenReason) =>
  new HabitForbidden({ id: null, reason })
const reminderForbidden = (reason: ForbiddenReason) =>
  new ReminderForbidden({ id: null, reason })
const occasionForbidden = (reason: ForbiddenReason) =>
  new OccasionForbidden({ id: null, reason })
const captureForbidden = (reason: ForbiddenReason) =>
  new CaptureForbidden({ reason })

export const RpcHandlers = ApiRpcs.toLayer({
  CreateList: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetList: ({ id }, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateList: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  DeleteList: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.remove(viewer, input))),
    ),
  ListLists: (_input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.list(viewer))),
    ),

  CreateListItem: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.createItem(viewer, input))),
    ),
  AppendListItems: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.appendItems(viewer, input))),
    ),
  ListListItems: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.listItems(viewer, input))),
    ),
  UpdateListItem: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.updateItem(viewer, input))),
    ),
  SetListItemChecked: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(
        Effect.flatMap(svc => svc.setItemChecked(viewer, input)),
      ),
    ),
  DeleteListItem: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.deleteItem(viewer, input))),
    ),
  ReorderListItems: (input, { headers }) =>
    withViewer(headers, listForbidden, viewer =>
      ListService.pipe(Effect.flatMap(svc => svc.reorder(viewer, input))),
    ),

  CreateTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetTask: ({ id }, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  MoveTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.move(viewer, input))),
    ),
  StartTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.start(viewer, input))),
    ),
  CompleteTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.complete(viewer, input))),
    ),
  UndoTask: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.undo(viewer, input))),
    ),
  ListTasks: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.list(viewer, input))),
    ),
  GetTaskBuckets: (_input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.buckets(viewer))),
    ),

  CreateProject: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.createProject(viewer, input))),
    ),
  RenameProject: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.renameProject(viewer, input))),
    ),
  ListProjects: (_input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.listProjects(viewer))),
    ),

  CreateTag: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.createTag(viewer, input))),
    ),
  RenameTag: (input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.renameTag(viewer, input))),
    ),
  ListTags: (_input, { headers }) =>
    withViewer(headers, taskForbidden, viewer =>
      TaskService.pipe(Effect.flatMap(svc => svc.listTags(viewer))),
    ),

  // ── Notes ─────────────────────────────────────────────────────────────

  CreateNote: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetNote: ({ id }, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  SaveNote: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.save(viewer, input))),
    ),
  UpdateNote: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  SetNotePinned: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.setPinned(viewer, input))),
    ),
  SetNoteArchived: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.setArchived(viewer, input))),
    ),
  SetNoteTags: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.setTags(viewer, input))),
    ),
  TrashNote: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.trash(viewer, input))),
    ),
  RestoreNote: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.restore(viewer, input))),
    ),
  ListNotes: (input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.list(viewer, input))),
    ),
  ListPinnedNotes: (_input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.listPinned(viewer))),
    ),
  ListTrashNotes: (_input, { headers }) =>
    withViewer(headers, noteForbidden, viewer =>
      NoteService.pipe(Effect.flatMap(svc => svc.listTrash(viewer))),
    ),

  // ── Events ────────────────────────────────────────────────────────────

  CreateEvent: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetEvent: ({ id }, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateEvent: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  DeleteEvent: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.delete(viewer, input))),
    ),
  ListEvents: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.list(viewer, input))),
    ),
  ListEventOccurrences: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(Effect.flatMap(svc => svc.occurrences(viewer, input))),
    ),
  EditEventOccurrence: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(
        Effect.flatMap(svc => svc.editOccurrence(viewer, input)),
      ),
    ),
  DeleteEventOccurrence: (input, { headers }) =>
    withViewer(headers, eventForbidden, viewer =>
      EventService.pipe(
        Effect.flatMap(svc => svc.deleteOccurrence(viewer, input)),
      ),
    ),

  // ── Habits ────────────────────────────────────────────────────────────

  CreateHabit: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetHabit: ({ id }, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateHabit: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  DeleteHabit: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.delete(viewer, input))),
    ),
  RestoreHabit: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.restore(viewer, input))),
    ),
  ListHabits: (_input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.list(viewer))),
    ),
  LogHabitEntry: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.logEntry(viewer, input))),
    ),
  ListHabitEntries: (input, { headers }) =>
    withViewer(headers, habitForbidden, viewer =>
      HabitService.pipe(Effect.flatMap(svc => svc.entries(viewer, input))),
    ),

  // ── Reminders ──────────────────────────────────────────────────────────
  CreateReminder: (input, { headers }) =>
    withViewer(headers, reminderForbidden, viewer =>
      ReminderService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetReminder: ({ id }, { headers }) =>
    withViewer(headers, reminderForbidden, viewer =>
      ReminderService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateReminder: (input, { headers }) =>
    withViewer(headers, reminderForbidden, viewer =>
      ReminderService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  DeleteReminder: (input, { headers }) =>
    withViewer(headers, reminderForbidden, viewer =>
      ReminderService.pipe(Effect.flatMap(svc => svc.delete(viewer, input))),
    ),
  ListReminders: (input, { headers }) =>
    withViewer(headers, reminderForbidden, viewer =>
      ReminderService.pipe(Effect.flatMap(svc => svc.list(viewer, input))),
    ),

  // ── Occasions ─────────────────────────────────────────────────────────

  CreateOccasion: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(Effect.flatMap(svc => svc.create(viewer, input))),
    ),
  GetOccasion: ({ id }, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(Effect.flatMap(svc => svc.get(viewer, id))),
    ),
  UpdateOccasion: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(Effect.flatMap(svc => svc.update(viewer, input))),
    ),
  DeleteOccasion: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(Effect.flatMap(svc => svc.delete(viewer, input))),
    ),
  ListOccasions: (_input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(Effect.flatMap(svc => svc.list(viewer))),
    ),
  ListOccasionOccurrences: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(
        Effect.flatMap(svc => svc.occurrences(viewer, input)),
      ),
    ),
  ListOccasionReminders: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(
        Effect.flatMap(svc => svc.advanceReminders(viewer, input)),
      ),
    ),
  MaterialiseOccasionReminders: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(
        Effect.flatMap(svc => svc.materialiseReminders(viewer, input)),
      ),
    ),
  PrepareOccasionTask: (input, { headers }) =>
    withViewer(headers, occasionForbidden, viewer =>
      OccasionService.pipe(
        Effect.flatMap(svc => svc.prepareTask(viewer, input)),
      ),
    ),

  // ── Capture ───────────────────────────────────────────────────────────

  DissectCapture: (input, { headers }) =>
    withViewer(headers, captureForbidden, viewer =>
      CaptureService.pipe(Effect.flatMap(svc => svc.dissect(viewer, input))),
    ),
  CommitCapture: (input, { headers }) =>
    withViewer(headers, captureForbidden, viewer =>
      CaptureService.pipe(Effect.flatMap(svc => svc.commit(viewer, input))),
    ),
  ListCaptures: (input, { headers }) =>
    withViewer(headers, captureForbidden, viewer =>
      CaptureService.pipe(Effect.flatMap(svc => svc.list(viewer, input))),
    ),
  DeleteCapture: (input, { headers }) =>
    withViewer(headers, captureForbidden, viewer =>
      CaptureService.pipe(Effect.flatMap(svc => svc.remove(viewer, input))),
    ),
})
