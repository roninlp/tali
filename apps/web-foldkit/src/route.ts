import { Schema, pipe } from 'effect'
import {
  defineRouteUnion,
  literal,
  mapTo,
  oneOf,
  parseUrlWithFallback,
  root,
  schemaSegment,
  slash,
} from 'foldkit/route'

import { ListId, NoteId } from '@tali/domain'

export const AppRoute = defineRouteUnion({
  Home: {},
  Login: {},
  Register: {},
  Today: {},
  Tasks: {},
  Lists: {},
  List: { listId: ListId },
  Notes: {},
  Note: { noteId: NoteId },
  NotesTrash: {},
  Habits: {},
  Calendar: {},
  Reminders: {},
  Settings: {},
  Household: {},
  PushHealth: {},
  NotFound: { path: Schema.String },
})

export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(root, mapTo(AppRoute.Home))

export const loginRouter = pipe(literal('login'), mapTo(AppRoute.Login))

export const registerRouter = pipe(
  literal('register'),
  mapTo(AppRoute.Register),
)

export const todayRouter = pipe(literal('today'), mapTo(AppRoute.Today))

export const tasksRouter = pipe(literal('tasks'), mapTo(AppRoute.Tasks))

export const listsRouter = pipe(literal('lists'), mapTo(AppRoute.Lists))

export const listRouter = pipe(
  literal('lists'),
  slash(schemaSegment('listId', ListId)),
  mapTo(AppRoute.List),
)

export const notesRouter = pipe(literal('notes'), mapTo(AppRoute.Notes))

export const noteRouter = pipe(
  literal('notes'),
  slash(schemaSegment('noteId', NoteId)),
  mapTo(AppRoute.Note),
)

export const notesTrashRouter = pipe(
  literal('notes'),
  slash(literal('trash')),
  mapTo(AppRoute.NotesTrash),
)

/** The task board row a Today title links to. */
export const taskAnchorPath = (taskId: string): string =>
  `${tasksRouter()}#task-${taskId}`

/** A note detail path from a plain NoteId string. */
export const notePath = (noteId: string): string =>
  noteRouter({ noteId: NoteId.make(noteId) })

/** A list detail path from a plain list id string. */
export const listPath = (listId: string): string =>
  listRouter({ listId: ListId.make(listId) })

export const habitsRouter = pipe(literal('habits'), mapTo(AppRoute.Habits))

export const calendarRouter = pipe(
  literal('calendar'),
  mapTo(AppRoute.Calendar),
)

export const remindersRouter = pipe(
  literal('reminders'),
  mapTo(AppRoute.Reminders),
)

export const settingsRouter = pipe(
  literal('settings'),
  mapTo(AppRoute.Settings),
)

export const householdRouter = pipe(
  literal('household'),
  mapTo(AppRoute.Household),
)

export const pushHealthRouter = pipe(
  literal('push-health'),
  mapTo(AppRoute.PushHealth),
)

const routeParser = oneOf(
  homeRouter,
  loginRouter,
  registerRouter,
  todayRouter,
  tasksRouter,
  habitsRouter,
  calendarRouter,
  remindersRouter,
  settingsRouter,
  householdRouter,
  pushHealthRouter,
  notesTrashRouter,
  notesRouter,
  noteRouter,
  listsRouter,
  listRouter,
)

export const urlToAppRoute = parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)
