import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import type { PushSubscriptionJson } from './lib/push/subscription'
import * as Push from './push'
import { USER_ID, pushModel } from './test-fixtures'

const subscription: PushSubscriptionJson = {
  endpoint: 'https://push.example.test/subscription',
  expirationTime: null,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
}

const environment = {
  isSupported: true,
  isSecure: true,
  isInstalled: false,
  permission: 'default' as const,
}

const signedIn = () => pushModel({ maybeUserId: Option.some(USER_ID) })

describe('session and visibility', () => {
  test('signing in refreshes the subscription and drains queued taps', () => {
    const applied = Push.applySession(
      pushModel({ maybeUserId: Option.none() }),
      Option.some(USER_ID),
    )

    expect(applied.model.maybeUserId).toStrictEqual(Option.some(USER_ID))
    expect(applied.commands).toBeDefined()
  })

  test('becoming visible re-reads the environment and drains the queue', () => {
    story(
      Push.update,
      given(signedIn()),
      message(Push.Message.ChangedVisibility({ isVisible: true })),
      Command.expectHas(Push.ReadPushEnvironment),
      Command.resolve(
        Push.ReadPushEnvironment,
        Push.Message.CompletedReadPushEnvironment({
          environment: { ...environment, permission: 'granted' },
        }),
      ),
      Command.expectHas(Push.ReadReminderActions),
      Command.resolve(
        Push.ReadReminderActions,
        Push.Message.CompletedReadReminderActions({
          maybeLastAction: Option.none(),
        }),
      ),
      Command.expectHas(Push.DrainReminderActions),
      Command.resolve(
        Push.DrainReminderActions,
        Push.Message.CompletedDrainReminderActions({
          drained: 0,
          maybeLastAction: Option.none(),
        }),
      ),
      model(next => {
        expect(next.environment.permission).toBe('granted')
      }),
    )
  })

  test('a hidden tab does no work', () => {
    story(
      Push.update,
      given(signedIn()),
      message(Push.Message.ChangedVisibility({ isVisible: false })),
      Command.expectNone(),
    )
  })
})

describe('subscription state', () => {
  test('a successful refresh adopts the server key and the browser subscription', () => {
    story(
      Push.update,
      given(signedIn()),
      message(
        Push.Message.SucceededRefreshPush({
          maybeUserId: Option.some(USER_ID),
          environment,
          publicKey: 'vapid-key',
          maybeSubscription: Option.some(subscription),
          maybeError: Option.none(),
        }),
      ),
      model(next => {
        expect(next.publicKey).toBe('vapid-key')
        expect(next.maybeSubscription).toStrictEqual(Option.some(subscription))
        expect(next.isBusy).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a refresh for a previous sign-in is ignored', () => {
    story(
      Push.update,
      given(
        pushModel({
          maybeUserId: Option.some('0192f0a0-0000-7000-8000-000000000099'),
          publicKey: '',
        }),
      ),
      message(
        Push.Message.SucceededRefreshPush({
          maybeUserId: Option.some(USER_ID),
          environment,
          publicKey: 'vapid-key',
          maybeSubscription: Option.some(subscription),
          maybeError: Option.none(),
        }),
      ),
      model(next => {
        expect(next.publicKey).toBe('')
        expect(next.maybeSubscription).toStrictEqual(Option.none())
      }),
      Command.expectNone(),
    )
  })

  test('enabling requests permission in a Command and shows the busy state', () => {
    story(
      Push.update,
      given(pushModel({ publicKey: 'vapid-key' })),
      message(Push.Message.ClickedEnablePush()),
      model(next => {
        expect(next.isBusy).toBe(true)
        expect(next.maybeError).toStrictEqual(Option.none())
      }),
      Command.expectExact(
        Push.EnablePush({
          maybeUserId: Option.some(USER_ID),
          publicKey: 'vapid-key',
        }),
      ),
      Command.resolve(
        Push.EnablePush,
        Push.Message.SucceededEnablePush({
          maybeUserId: Option.some(USER_ID),
          environment: { ...environment, permission: 'granted' },
          subscription,
          maybeError: Option.none(),
        }),
      ),
      Command.expectHas(Push.ReadReminderActions),
      Command.resolve(
        Push.ReadReminderActions,
        Push.Message.CompletedReadReminderActions({
          maybeLastAction: Option.none(),
        }),
      ),
      model(next => {
        expect(next.isBusy).toBe(false)
        expect(next.environment.permission).toBe('granted')
        expect(next.maybeSubscription).toStrictEqual(Option.some(subscription))
      }),
    )
  })

  test('a denied permission is reported and no subscription is kept', () => {
    story(
      Push.update,
      given(signedIn()),
      message(Push.Message.ClickedEnablePush()),
      Command.resolve(
        Push.EnablePush,
        Push.Message.FailedEnablePush({
          maybeUserId: Option.some(USER_ID),
          environment: { ...environment, permission: 'denied' },
          message: 'اجازه‌ی اعلان داده نشد.',
        }),
      ),
      model(next => {
        expect(next.isBusy).toBe(false)
        expect(next.environment.permission).toBe('denied')
        expect(next.maybeSubscription).toStrictEqual(Option.none())
        expect(next.maybeError).toStrictEqual(
          Option.some('اجازه‌ی اعلان داده نشد.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('disabling unsubscribes this device', () => {
    story(
      Push.update,
      given(pushModel({ maybeSubscription: Option.some(subscription) })),
      message(Push.Message.ClickedDisablePush()),
      model(next => {
        expect(next.isBusy).toBe(true)
      }),
      Command.expectHas(
        Push.DisablePush({ maybeUserId: Option.some(USER_ID) }),
      ),
      Command.resolve(
        Push.DisablePush,
        Push.Message.SucceededDisablePush({
          maybeUserId: Option.some(USER_ID),
        }),
      ),
      model(next => {
        expect(next.isBusy).toBe(false)
        expect(next.maybeSubscription).toStrictEqual(Option.none())
      }),
      Command.expectNone(),
    )
  })

  test('copying the subscription JSON hands it to a Command', () => {
    story(
      Push.update,
      given(pushModel({ maybeSubscription: Option.some(subscription) })),
      message(Push.Message.ClickedCopySubscription()),
      Command.expectExact(Push.CopySubscription({ subscription })),
      Command.resolve(
        Push.CopySubscription,
        Push.Message.CompletedCopySubscription({ isCopied: true }),
      ),
      model(next => {
        expect(next.isCopied).toBe(true)
      }),
    )
  })
})

describe('notification actions', () => {
  test('a Done tap is recorded and drained immediately', () => {
    story(
      Push.update,
      given(signedIn()),
      message(
        Push.Message.ReceivedReminderAction({
          dispatchId: 'dispatch-1',
          action: 'done',
          snoozeMinutes: Option.none(),
          at: '2026-10-19T08:00:00.000Z',
        }),
      ),
      model(next => {
        expect(next.maybeLastAction).toStrictEqual(
          Option.some({
            dispatchId: 'dispatch-1',
            action: 'done',
            at: '2026-10-19T08:00:00.000Z',
          }),
        )
      }),
      Command.expectHas(Push.DrainReminderActions),
      Command.resolve(
        Push.DrainReminderActions,
        Push.Message.CompletedDrainReminderActions({
          drained: 1,
          maybeLastAction: Option.none(),
        }),
      ),
      model(next => {
        // The drain removed the queue row, but the panel still shows the tap.
        expect(next.maybeLastAction).toStrictEqual(
          Option.some({
            dispatchId: 'dispatch-1',
            action: 'done',
            at: '2026-10-19T08:00:00.000Z',
          }),
        )
      }),
    )
  })

  test('a snooze tap carries its minutes into the queue record', () => {
    story(
      Push.update,
      given(signedIn()),
      message(
        Push.Message.ReceivedReminderAction({
          dispatchId: 'dispatch-2',
          action: 'snooze',
          snoozeMinutes: Option.some(5),
          at: '2026-10-19T08:05:00.000Z',
        }),
      ),
      model(next => {
        expect(next.maybeLastAction).toStrictEqual(
          Option.some({
            dispatchId: 'dispatch-2',
            action: 'snooze',
            snoozeMinutes: 5,
            at: '2026-10-19T08:05:00.000Z',
          }),
        )
      }),
      Command.expectHas(Push.DrainReminderActions),
      Command.resolve(
        Push.DrainReminderActions,
        Push.Message.CompletedDrainReminderActions({
          drained: 0,
          maybeLastAction: Option.some({
            dispatchId: 'dispatch-2',
            action: 'snooze',
            snoozeMinutes: 5,
            at: '2026-10-19T08:05:00.000Z',
          }),
        }),
      ),
    )
  })

  test('a subscription rotation refreshes the registration', () => {
    story(
      Push.update,
      given(signedIn()),
      message(Push.Message.ReceivedPushSubscriptionChange()),
      Command.expectExact(
        Push.RefreshPush({ maybeUserId: Option.some(USER_ID) }),
      ),
      Command.resolve(
        Push.RefreshPush,
        Push.Message.SucceededRefreshPush({
          maybeUserId: Option.some(USER_ID),
          environment,
          publicKey: 'vapid-key',
          maybeSubscription: Option.some(subscription),
          maybeError: Option.none(),
        }),
      ),
    )
  })
})
