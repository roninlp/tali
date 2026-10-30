import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import { fromString, toString as urlToString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { LoadExternal, Message, Model, NavigateInternal, update } from './main'
import { AppRoute } from './route'
import * as Theme from './theme'

const modelAt = (route: AppRoute): Model =>
  Model.make({
    route,
    theme: Theme.Model.make({ theme: 'Tali' }),
  })

const url = (path: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${path}`),
    () => new Error(`Failed to parse url: ${path}`),
  )

describe('ChangedUrl', () => {
  test('navigating to /notes/trash keeps the trash route', () => {
    story(
      update,
      given(modelAt(AppRoute.Notes())),
      message(Message.ChangedUrl({ url: url('/notes/trash') })),
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
