import { Option } from 'effect'
import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vite-plus/test'

import * as Push from './push'
import { USER_ID, pushModel } from './test-fixtures'

const configured = () =>
  pushModel({
    publicKey: 'vapid-key',
    environment: {
      isSupported: true,
      isSecure: true,
      isInstalled: false,
      permission: 'granted',
    },
  })

describe('push health panel', () => {
  test('an unconfigured server explains the missing VAPID key', () => {
    scene(
      { update: Push.update, view: Push.healthView },
      given(pushModel()),
      expect(role('heading', { name: 'وضعیت اعلان‌ها' })).toExist(),
      expect(text('پشتیبانی می‌شود')).toExist(),
      expect(text('کلید عمومی VAPID')).toExist(),
      expect(text('تنظیم نشده')).toExist(),
      expect(role('button', { name: 'فعال‌سازی اعلان‌ها' })).toBeDisabled(),
    )
  })

  test('a configured, granted device offers enable and refresh', () => {
    scene(
      { update: Push.update, view: Push.healthView },
      given(configured()),
      expect(role('button', { name: 'فعال‌سازی اعلان‌ها' })).toBeEnabled(),
      expect(role('button', { name: 'تازه‌سازی وضعیت' })).toBeEnabled(),
      click(role('button', { name: 'تازه‌سازی وضعیت' })),
      Command.expectExact(
        Push.RefreshPush({ maybeUserId: Option.some(USER_ID) }),
      ),
      Command.resolve(
        Push.RefreshPush,
        Push.Message.SucceededRefreshPush({
          maybeUserId: Option.some(USER_ID),
          environment: {
            isSupported: true,
            isSecure: true,
            isInstalled: false,
            permission: 'granted',
          },
          publicKey: 'vapid-key',
          maybeSubscription: Option.none(),
          maybeError: Option.none(),
        }),
      ),
    )
  })

  test('a subscribed device can disable and copy its subscription', () => {
    scene(
      { update: Push.update, view: Push.healthView },
      given(
        pushModel({
          publicKey: 'vapid-key',
          environment: {
            isSupported: true,
            isSecure: true,
            isInstalled: true,
            permission: 'granted',
          },
          maybeSubscription: Option.some({
            endpoint: 'https://push.example.test/subscription',
            expirationTime: null,
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          }),
        }),
      ),
      expect(role('button', { name: 'بررسی و ثبت دوباره' })).toExist(),
      expect(role('button', { name: 'لغو اشتراک این دستگاه' })).toExist(),
      expect(text('ثبت شده')).toExist(),
    )
  })

  test('a failure is shown as a calm alert', () => {
    scene(
      { update: Push.update, view: Push.healthView },
      given(
        pushModel({
          maybeError: Option.some('کلید عمومی VAPID روی سرور تنظیم نشده است.'),
        }),
      ),
      expect(text('کلید عمومی VAPID روی سرور تنظیم نشده است.')).toExist(),
    )
  })
})
