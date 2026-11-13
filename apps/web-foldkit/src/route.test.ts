import { Option } from 'effect'
import { fromString } from 'foldkit/url'
import { describe, expect, test } from 'vite-plus/test'

import { ListId, NoteId } from '@tali/domain'

import {
  AppRoute,
  calendarRouter,
  habitsRouter,
  homeRouter,
  householdRouter,
  listRouter,
  listsRouter,
  loginRouter,
  noteRouter,
  notesRouter,
  notesTrashRouter,
  pushHealthRouter,
  registerRouter,
  remindersRouter,
  settingsRouter,
  tasksRouter,
  todayRouter,
  urlToAppRoute,
} from './route'

const LIST_ID = ListId.make('018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b')
const NOTE_ID = NoteId.make('018f3a4c-7b2d-7c4e-8a1b-2c3d4e5f6a7b')

const url = (path: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${path}`),
    () => new Error(`Failed to parse url: ${path}`),
  )

const parseCases: ReadonlyArray<readonly [string, AppRoute]> = [
  ['/', AppRoute.Home()],
  ['/login', AppRoute.Login()],
  ['/register', AppRoute.Register()],
  ['/today', AppRoute.Today()],
  ['/tasks', AppRoute.Tasks()],
  ['/lists', AppRoute.Lists()],
  [`/lists/${LIST_ID}`, AppRoute.List({ listId: LIST_ID })],
  ['/notes', AppRoute.Notes()],
  [`/notes/${NOTE_ID}`, AppRoute.Note({ noteId: NOTE_ID })],
  ['/notes/trash', AppRoute.NotesTrash()],
  ['/habits', AppRoute.Habits()],
  ['/calendar', AppRoute.Calendar()],
  ['/reminders', AppRoute.Reminders()],
  ['/settings', AppRoute.Settings()],
  ['/household', AppRoute.Household()],
  ['/push-health', AppRoute.PushHealth()],
]

const buildCases: ReadonlyArray<readonly [string, () => string]> = [
  ['/', () => homeRouter()],
  ['/login', () => loginRouter()],
  ['/register', () => registerRouter()],
  ['/today', () => todayRouter()],
  ['/tasks', () => tasksRouter()],
  ['/lists', () => listsRouter()],
  [`/lists/${LIST_ID}`, () => listRouter({ listId: LIST_ID })],
  ['/notes', () => notesRouter()],
  [`/notes/${NOTE_ID}`, () => noteRouter({ noteId: NOTE_ID })],
  ['/notes/trash', () => notesTrashRouter()],
  ['/habits', () => habitsRouter()],
  ['/calendar', () => calendarRouter()],
  ['/reminders', () => remindersRouter()],
  ['/settings', () => settingsRouter()],
  ['/household', () => householdRouter()],
  ['/push-health', () => pushHealthRouter()],
]

describe('urlToAppRoute', () => {
  test.each(parseCases)('parses %s into its route', (path, expected) => {
    expect(urlToAppRoute(url(path))).toStrictEqual(expected)
  })

  test.each([
    '/missing',
    '/today/extra',
    '/notes/trash/extra',
    '/lists/not-a-uuid',
  ])('maps %s to NotFound with the path captured', path => {
    expect(urlToAppRoute(url(path))).toStrictEqual(AppRoute.NotFound({ path }))
  })
})

describe('routers', () => {
  test.each(buildCases)('%s builds the canonical URL', (expected, build) => {
    expect(build()).toBe(expected)
  })

  test.each(buildCases)('%s round-trips through the parser', (path, build) => {
    expect(urlToAppRoute(url(build()))).toStrictEqual(urlToAppRoute(url(path)))
  })
})
