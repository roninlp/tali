import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { fromString, toString as urlToString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { Dialog } from '@foldkit/ui'
import { ListId, NoteId } from '@tali/domain'

import { COLOR_CHOICES, ICON_CHOICES } from './lists-model'
import { LoadExternal, Message, NavigateInternal, update } from './main'
import { emptyMirrorSnapshot } from './mirror'
import * as Calendar from './page/calendar'
import * as Lists from './page/lists'
import * as Notes from './page/notes'
import * as Reminders from './page/reminders'
import { AppRoute, listPath, notePath, notesRouter } from './route'
import * as Settings from './settings'
import * as Sync from './sync'
import { modelAt } from './test-fixtures'

const url = (path: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${path}`),
    () => new Error(`Failed to parse url: ${path}`),
  )

const LIST_ID = '018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b'
const NOTE_ID = '018f3a4c-7b2d-7c4e-8a1b-2c3d4e5f6a7b'

const emptySnapshot = {
  at: 500,
  pending: 0,
  maybeFailed: Option.none<number>(),
  failedRefreshedAt: 0,
  mirror: emptyMirrorSnapshot(),
  pendingKeys: [],
}

describe('ChangedUrl', () => {
  test('navigating to /notes/trash keeps the trash route', () => {
    story(
      update,
      given(modelAt(AppRoute.Notes())),
      message(Message.ChangedUrl({ url: url('/notes/trash') })),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.NotesTrash())
      }),
    )
  })

  test('navigating to a list detail captures the typed id', () => {
    story(
      update,
      given(modelAt(AppRoute.Lists())),
      message(
        Message.ChangedUrl({
          url: url('/lists/018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b'),
        }),
      ),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      model(model => {
        if (model.route._tag === 'List') {
          expect(model.route.listId).toBe(
            '018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b',
          )
        } else {
          throw new Error('Expected the List route')
        }
      }),
    )
  })

  test('an unknown deep path becomes NotFound with the path captured', () => {
    story(
      update,
      given(modelAt(AppRoute.Today())),
      message(Message.ChangedUrl({ url: url('/notes/trash/extra') })),
      model(model => {
        expect(model.route).toStrictEqual(
          AppRoute.NotFound({ path: '/notes/trash/extra' }),
        )
      }),
    )
  })

  test('leaving /settings drops the password form', () => {
    const filled = Settings.Model.make({
      currentPassword: 'old password value',
      newPassword: 'new password value',
      confirmPassword: 'new password value',
      maybeError: Option.none(),
      hasSucceeded: true,
      isSubmitting: false,
    })

    story(
      update,
      given(
        modifyFields(modelAt(AppRoute.Settings()), {
          settings: () => filled,
        }),
      ),
      message(Message.ChangedUrl({ url: url('/calendar') })),
      Command.expectHas(Calendar.ReadCalendarClock()),
      Command.resolve(
        Calendar.ReadCalendarClock,
        Calendar.Message.TickedCalendar({ now: 500 }),
      ),
      Command.expectHas(Calendar.FetchCalendar),
      Command.resolve(
        Calendar.FetchCalendar,
        Calendar.Message.FailedFetchWeek({
          generation: 2,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      Command.expectHas(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Calendar())
        expect(model.settings).toStrictEqual(Settings.initialModel())
      }),
    )
  })

  test('opening /reminders drains the queue and reads the ledger', () => {
    story(
      update,
      given(modelAt(AppRoute.Today())),
      message(Message.ChangedUrl({ url: url('/reminders') })),
      Command.expectHas(
        Reminders.DrainQueueAndFetchInbox({
          generation: 1,
          history: false,
        }),
      ),
      Command.resolve(
        Reminders.DrainQueueAndFetchInbox,
        Reminders.Message.CompletedDrainQueueAndFetchInbox({
          generation: 1,
          items: [],
        }),
      ),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Reminders())
      }),
    )
  })
})

describe('ClickedLink', () => {
  test('an internal link pushes the target URL', () => {
    const target = url('/tasks')

    story(
      update,
      given(modelAt(AppRoute.Today())),
      message(
        Message.ClickedLink({ request: UrlRequest.Internal({ url: target }) }),
      ),
      Command.expectHas(NavigateInternal({ url: urlToString(target) })),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    )
  })

  test('an external link loads the href in the browser', () => {
    story(
      update,
      given(modelAt(AppRoute.Today())),
      message(
        Message.ClickedLink({
          request: UrlRequest.External({ href: 'https://example.com' }),
        }),
      ),
      Command.expectHas(LoadExternal({ href: 'https://example.com' })),
      Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
    )
  })
})

describe('lists navigation', () => {
  test('a list detail URL stores the typed id before the screen renders', () => {
    story(
      update,
      given(modelAt(AppRoute.Lists())),
      message(
        Message.ChangedUrl({
          url: url(`/lists/${LIST_ID}`),
        }),
      ),
      Command.expectExact(
        Sync.ReadMirror({ pendingBefore: 0, failedRefreshedAt: 0 }),
      ),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      model(model => {
        expect(model.route._tag).toBe('List')
        expect(model.lists.maybeListId).toStrictEqual(
          Option.some(ListId.make(LIST_ID)),
        )
      }),
    )
  })

  test('creating a list opens its detail and refreshes the mirror', () => {
    story(
      update,
      given(modelAt(AppRoute.Lists())),
      message(
        Message.GotListsMessage({
          message: Lists.Message.UpdatedIndexTitle({ value: 'خرید' }),
        }),
      ),
      message(
        Message.GotListsMessage({
          message: Lists.Message.SubmittedCreateList(),
        }),
      ),
      Command.expectHas(
        Lists.CreateList({
          title: 'خرید',
          color: COLOR_CHOICES[0] ?? '',
          icon: ICON_CHOICES[0] ?? '',
          sort: 'manual',
          checkedPlacement: 'bottom',
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Lists.CreateList,
        Lists.Message.CompletedCreateList({
          listId: LIST_ID,
          title: 'خرید',
        }),
      ),
      Command.expectHas(NavigateInternal({ url: listPath(LIST_ID) })),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      model(model => {
        expect(model.lists.indexTitle).toBe('')
      }),
    )
  })

  test('deleting the open list returns to the index', () => {
    story(
      update,
      given(modelAt(AppRoute.List({ listId: ListId.make(LIST_ID) }))),
      message(
        Message.GotListsMessage({
          message: Lists.Message.ClickedDeleteList({
            listId: LIST_ID,
            title: 'خرید',
            scope: 'detail',
          }),
        }),
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      message(
        Message.GotListsMessage({
          message: Lists.Message.ConfirmedDeleteList(),
        }),
      ),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      Command.expectHas(Lists.DeleteList({ listId: LIST_ID, itemIds: [] })),
      Command.resolve(
        Lists.DeleteList,
        Lists.Message.CompletedDeleteList({ listId: LIST_ID }),
      ),
      Command.expectHas(NavigateInternal({ url: '/lists' })),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    )
  })
})

describe('notes navigation', () => {
  test('creating a note opens its editor and refreshes the mirror', () => {
    story(
      update,
      given(modelAt(AppRoute.Notes())),
      message(
        Message.GotNotesMessage({
          message: Notes.Message.SubmittedCreateNote(),
        }),
      ),
      Command.expectHas(Notes.CreateNote()),
      Command.resolve(
        Notes.CreateNote,
        Notes.Message.CompletedCreateNote({ noteId: NOTE_ID }),
      ),
      Command.expectHas(NavigateInternal({ url: notePath(NOTE_ID) })),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    )
  })

  test('trashing the open note returns to the notes index', () => {
    story(
      update,
      given(modelAt(AppRoute.Note({ noteId: NoteId.make(NOTE_ID) }))),
      message(
        Message.GotNotesMessage({
          message: Notes.Message.CompletedTrashNote({ noteId: NOTE_ID }),
        }),
      ),
      Command.expectHas(NavigateInternal({ url: notesRouter() })),
      Command.resolve(
        Sync.ReadMirror,
        Sync.Message.SucceededReadMirror(emptySnapshot),
      ),
      Command.resolve(
        Notes.LoadNoteEditor,
        Notes.Message.FailedLoadNote({
          generation: 2,
          message: 'خواندن یادداشت ممکن نشد.',
        }),
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
    )
  })
})
