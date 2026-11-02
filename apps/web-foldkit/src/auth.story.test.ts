import { Option } from 'effect'
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import * as Auth from './auth'
import type { AuthFailure } from './lib/auth-api'
import {
  authModel,
  failed,
  restoring,
  sessionWithHousehold,
  sessionWithoutHousehold,
  signedIn,
} from './test-fixtures'

const networkFailure: AuthFailure = { code: 'Network', retryable: true }
const unauthorizedFailure: AuthFailure = {
  code: 'Unauthorized',
  retryable: false,
}

const cachedSignedIn = (): Auth.Model =>
  modifyFields(authModel(signedIn()), { restoreAttempt: () => 1 })

describe('session restore', () => {
  test('a successful restore signs in and caches the session', () => {
    story(
      Auth.update,
      given(authModel(restoring())),
      message(
        Auth.Message.SucceededRestoreSession({
          attempt: 1,
          session: sessionWithHousehold,
        }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(
          Auth.SessionStatus.SignedIn({
            session: sessionWithHousehold,
            maybeBootFailure: Option.none(),
          }),
        )
      }),
      expectOutMessage(
        Auth.OutMessage.RestoredSession({ session: sessionWithHousehold }),
      ),
      Command.expectHas(Auth.CacheSession({ session: sessionWithHousehold })),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
    )
  })

  test('Unauthorized clears the cached session and signs out', () => {
    story(
      Auth.update,
      given(cachedSignedIn()),
      message(
        Auth.Message.FailedRestoreSession({
          attempt: 1,
          failure: unauthorizedFailure,
        }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(Auth.SessionStatus.SignedOut())
      }),
      expectOutMessage(Auth.OutMessage.SignedOut()),
      Command.expectHas(Auth.ClearCachedSession),
      Command.resolve(
        Auth.ClearCachedSession,
        Auth.Message.CompletedClearCachedSession(),
      ),
    )
  })

  test('a network failure keeps the cached session and records the failure', () => {
    story(
      Auth.update,
      given(cachedSignedIn()),
      message(
        Auth.Message.FailedRestoreSession({
          attempt: 1,
          failure: networkFailure,
        }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(
          Auth.SessionStatus.SignedIn({
            session: sessionWithHousehold,
            maybeBootFailure: Option.some(networkFailure),
          }),
        )
      }),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('a network failure with no cached session becomes a boot error', () => {
    story(
      Auth.update,
      given(authModel(restoring())),
      message(
        Auth.Message.FailedRestoreSession({
          attempt: 1,
          failure: networkFailure,
        }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(
          Auth.SessionStatus.Failed({ failure: networkFailure }),
        )
      }),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('a restore response that lands after a newer attempt is ignored', () => {
    story(
      Auth.update,
      given(modifyFields(authModel(signedIn()), { restoreAttempt: () => 2 })),
      message(
        Auth.Message.SucceededRestoreSession({
          attempt: 1,
          session: sessionWithoutHousehold,
        }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(
          Auth.SessionStatus.SignedIn({
            session: sessionWithHousehold,
            maybeBootFailure: Option.none(),
          }),
        )
      }),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('retrying a failed restore returns to the restoring state', () => {
    story(
      Auth.update,
      given(authModel(failed(networkFailure))),
      message(Auth.Message.ClickedRetryRestore()),
      model(model => {
        expect(model.status).toStrictEqual(Auth.SessionStatus.Restoring())
        expect(model.restoreAttempt).toBe(2)
      }),
      Command.expectHas(Auth.RestoreSession({ attempt: 2 })),
      Command.resolve(
        Auth.RestoreSession,
        Auth.Message.SucceededRestoreSession({
          attempt: 2,
          session: sessionWithHousehold,
        }),
      ),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
    )
  })
})

describe('sign out', () => {
  test('signing out revokes the session and clears the cache', () => {
    story(
      Auth.update,
      given(authModel(signedIn())),
      message(Auth.Message.ClickedSignOut()),
      model(model => {
        expect(model.isSigningOut).toBe(true)
      }),
      Command.expectHas(Auth.SignOut),
      Command.resolve(Auth.SignOut, Auth.Message.SucceededSignOut()),
      model(model => {
        expect(model.status).toStrictEqual(Auth.SessionStatus.SignedOut())
        expect(model.isSigningOut).toBe(false)
      }),
      expectOutMessage(Auth.OutMessage.SignedOut()),
      Command.expectHas(Auth.ClearCachedSession),
      Command.resolve(
        Auth.ClearCachedSession,
        Auth.Message.CompletedClearCachedSession(),
      ),
    )
  })

  test('a failed sign-out keeps the session and reports the failure', () => {
    story(
      Auth.update,
      given(authModel(signedIn())),
      message(Auth.Message.ClickedSignOut()),
      Command.resolve(
        Auth.SignOut,
        Auth.Message.FailedSignOut({ failure: networkFailure }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(
          Auth.SessionStatus.SignedIn({
            session: sessionWithHousehold,
            maybeBootFailure: Option.none(),
          }),
        )
        expect(model.isSigningOut).toBe(false)
        expect(model.maybeSignOutFailure).toStrictEqual(
          Option.some(networkFailure),
        )
      }),
      Command.expectNone(),
      expectNoOutMessage(),
    )
  })

  test('a sign-out that answers Unauthorized clears the session anyway', () => {
    story(
      Auth.update,
      given(authModel(signedIn())),
      message(Auth.Message.ClickedSignOut()),
      Command.resolve(
        Auth.SignOut,
        Auth.Message.FailedSignOut({ failure: unauthorizedFailure }),
      ),
      model(model => {
        expect(model.status).toStrictEqual(Auth.SessionStatus.SignedOut())
      }),
      expectOutMessage(Auth.OutMessage.SignedOut()),
      Command.expectHas(Auth.ClearCachedSession),
      Command.resolve(
        Auth.ClearCachedSession,
        Auth.Message.CompletedClearCachedSession(),
      ),
    )
  })
})
