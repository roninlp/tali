import { Effect } from "effect"
import type { Headers } from "effect/http/Headers"
import { ApiRpcs } from "@tali/rpc"
import { NoteForbidden, TaskForbidden, Unauthorized } from "@tali/domain"
import { AuthService } from "./auth-service.js"
import { ListItemService } from "./list-item-service.js"
import { NoteService } from "./note-service.js"
import { PreferencesService } from "./preferences-service.js"
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
      timeZone: prefs.timeZone
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

export const RpcHandlers = ApiRpcs.toLayer({
  CreateListItem: (input) =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.create(input))),
  ListListItems: () =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.list())),
  ToggleListItem: ({ id, checked }) =>
    ListItemService.pipe(Effect.flatMap((svc) => svc.setChecked(id, checked))),

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
      NoteService.pipe(Effect.flatMap((svc) => svc.listTrash(viewer))))
})
