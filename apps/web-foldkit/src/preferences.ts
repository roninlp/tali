import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { AuthFailure } from './lib/auth-api'
import { authErrorMessage } from './lib/auth-copy'
import { preferencesApi } from './lib/preferences-api'
import {
  cachePreferences,
  readCachedPreferences,
} from './lib/preferences-cache'
import {
  DEFAULT_DIGITS,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEK_START,
  Digits,
  DisplayFields,
  Preferences,
  PreferencesPatch,
  PreferencesSource,
  WeekStart,
  changedDisplayFields,
  displayFieldsOf,
} from './preferences-model'
import type { Session } from './session'
import { buttonView } from './ui/button'
import {
  fieldView,
  formErrorView,
  selectInputView,
  textInputView,
} from './ui/field'

/**
 * The client preferences Submodel, ported from
 * `apps/web/src/lib/preferences.tsx`.
 *
 * Resolution order for what renders: the last server response cached on this
 * device (synchronous, so an offline boot already has the right week start and
 * digits) → the account profile/defaults → the Persian-first domain defaults.
 * A successful GET or PATCH updates the Model *and* the cache in the same
 * turn, so `/settings` and the P2.6 dashboard render without a reload.
 *
 * Preferences are deliberately **not** written through the sync outbox. They
 * are server-of-record display settings edited while online; queueing them
 * would mean a stale week start could be pushed over a newer value from the
 * other device. A failed PATCH shows a retryable error and the cache keeps the
 * last confirmed value. See ADR-0002.
 */

// MODEL

/** Only used while signed out, where route guards never read preferences. */
export const SIGNED_OUT_USER_ID = '00000000-0000-4000-8000-000000000000'

export const Model = Schema.Struct({
  maybeUserId: Schema.Option(Schema.String),
  /** The last server-confirmed (or cached) row, if one has been adopted. */
  maybePreferences: Schema.Option(Preferences),
  /** The profile values a user who never saved preferences should see. */
  defaults: DisplayFields,
  draft: DisplayFields,
  source: PreferencesSource,
  isSaving: Schema.Boolean,
  hasSaved: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const SessionProfile = Schema.Struct({
  userId: Schema.String,
  defaults: DisplayFields,
})
export type SessionProfile = typeof SessionProfile.Type

const decodeWeekStart = Schema.decodeUnknownOption(WeekStart)
const decodeDigits = Schema.decodeUnknownOption(Digits)

const weekStartOf = (value: string): WeekStart =>
  Option.match(decodeWeekStart(value), {
    onNone: () => DEFAULT_WEEK_START,
    onSome: weekStart => weekStart,
  })

const digitsOf = (value: string): Digits =>
  Option.match(decodeDigits(value), {
    onNone: () => DEFAULT_DIGITS,
    onSome: digits => digits,
  })

/** The profile values the auth session already carries. */
export const sessionProfile = (session: Session): SessionProfile =>
  SessionProfile.make({
    userId: session.user.id,
    defaults: DisplayFields.make({
      timeZone: session.user.timeZone,
      weekStart: weekStartOf(session.user.weekStart),
      digits: digitsOf(session.user.digits),
    }),
  })

const signedOutDefaults = (): DisplayFields =>
  DisplayFields.make({
    timeZone: DEFAULT_TIME_ZONE,
    weekStart: DEFAULT_WEEK_START,
    digits: DEFAULT_DIGITS,
  })

const initialModel = (
  maybeUserId: Option.Option<string>,
  defaults: DisplayFields,
  maybeCached: Option.Option<Preferences>,
): Model => {
  const maybeAdopted = Option.filter(maybeCached, preferences =>
    Option.exists(maybeUserId, userId => preferences.userId === userId),
  )

  return Model.make({
    maybeUserId,
    maybePreferences: maybeAdopted,
    defaults,
    draft: Option.match(maybeAdopted, {
      onNone: () => defaults,
      onSome: preferences => displayFieldsOf(preferences),
    }),
    source: Option.isSome(maybeAdopted) ? 'Cache' : 'Default',
    isSaving: false,
    hasSaved: false,
    maybeError: Option.none(),
  })
}

const confirmedDisplayFields = (model: Model): DisplayFields =>
  Option.match(model.maybePreferences, {
    onNone: () => model.defaults,
    onSome: preferences => displayFieldsOf(preferences),
  })

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchPreferences: {
    userId: Schema.String,
    preferences: Preferences,
  },
  FailedFetchPreferences: { userId: Schema.String, failure: AuthFailure },
  SucceededSavePreferences: { userId: Schema.String, preferences: Preferences },
  FailedSavePreferences: { userId: Schema.String, failure: AuthFailure },
  CompletedReadCachedPreferences: {
    userId: Schema.String,
    maybePreferences: Schema.Option(Preferences),
  },
  UpdatedTimeZoneDraft: { value: Schema.String },
  UpdatedWeekStartDraft: { value: WeekStart },
  UpdatedDigitsDraft: { value: Digits },
  SubmittedDisplayPreferences: {},
  ClickedRefreshPreferences: {},
  CompletedCachePreferences: {},
})
export type Message = typeof Message.Type

// COMMAND

export const FetchPreferences = Command.define('FetchPreferences', {
  args: { userId: Schema.String },
  messages: [Message.SucceededFetchPreferences, Message.FailedFetchPreferences],
  execute: ({ userId }) =>
    preferencesApi.get().pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededFetchPreferences({
              userId,
              preferences: result.value,
            })
          : Message.FailedFetchPreferences({ userId, failure: result.error }),
      ),
    ),
})

export const SavePreferences = Command.define('SavePreferences', {
  args: {
    userId: Schema.String,
    patch: PreferencesPatch,
  },
  messages: [Message.SucceededSavePreferences, Message.FailedSavePreferences],
  execute: ({ userId, patch }) =>
    preferencesApi.patch(patch).pipe(
      Effect.map(result =>
        result.ok
          ? Message.SucceededSavePreferences({
              userId,
              preferences: result.value,
            })
          : Message.FailedSavePreferences({ userId, failure: result.error }),
      ),
    ),
})

export const ReadCachedPreferences = Command.define('ReadCachedPreferences', {
  args: { userId: Schema.String },
  messages: [Message.CompletedReadCachedPreferences],
  execute: ({ userId }) =>
    Effect.sync(() =>
      Message.CompletedReadCachedPreferences({
        userId,
        maybePreferences: readCachedPreferences(userId),
      }),
    ),
})

export const CachePreferences = Command.define('CachePreferences', {
  args: { preferences: Preferences },
  messages: [Message.CompletedCachePreferences],
  execute: ({ preferences }) =>
    Effect.sync(() => {
      cachePreferences(preferences)
      return Message.CompletedCachePreferences()
    }),
})

// INIT

export type InitOptions = Readonly<{
  maybeUserId: Option.Option<string>
  maybeProfileDefaults: Option.Option<DisplayFields>
  maybeCachedPreferences: Option.Option<Preferences>
}>

export const init = (options: InitOptions): Update.Return<Model, Message> => {
  const defaults = Option.match(options.maybeProfileDefaults, {
    onNone: () => signedOutDefaults(),
    onSome: profileDefaults => profileDefaults,
  })
  const model = initialModel(
    options.maybeUserId,
    defaults,
    options.maybeCachedPreferences,
  )

  return Option.match(options.maybeUserId, {
    onNone: () => ({ model }),
    onSome: userId => ({
      model,
      commands: [FetchPreferences({ userId })],
    }),
  })
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const sameUser = (
  model: Model,
  maybeProfile: Option.Option<SessionProfile>,
): boolean =>
  Option.match(model.maybeUserId, {
    onNone: () => Option.isNone(maybeProfile),
    onSome: userId =>
      Option.exists(maybeProfile, profile => profile.userId === userId),
  })

/**
 * Adopt the session profile on a sign-in, and drop the row on a sign-out.
 * A same-user restore keeps the Model as-is: the boot `FetchPreferences` is
 * already reconciling it, and a duplicate GET would only race itself.
 */
export const applySession = (
  model: Model,
  maybeProfile: Option.Option<SessionProfile>,
): Update.Return<Model, Message> => {
  if (sameUser(model, maybeProfile)) {
    return { model }
  }

  return Option.match(maybeProfile, {
    onNone: () => ({
      model: initialModel(Option.none(), signedOutDefaults(), Option.none()),
    }),
    onSome: profile => {
      const next = initialModel(
        Option.some(profile.userId),
        profile.defaults,
        Option.none(),
      )

      return {
        model: next,
        commands: [ReadCachedPreferences({ userId: profile.userId })],
      }
    },
  })
}

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const invalidTimeZoneMessage =
  'منطقه‌ی زمانی معتبر نیست؛ مثل Asia/Tehran وارد کنید.'

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedReadCachedPreferences: ({ userId, maybePreferences }) => {
      if (!Option.contains(model.maybeUserId, userId)) {
        return { model }
      }

      return {
        model: Option.match(maybePreferences, {
          onNone: () =>
            modifyFields(model, {
              maybePreferences: () => Option.none(),
              source: () => 'Default',
            }),
          onSome: preferences =>
            modifyFields(model, {
              maybePreferences: () => Option.some(preferences),
              draft: () => displayFieldsOf(preferences),
              source: () => 'Cache',
            }),
        }),
        commands: [FetchPreferences({ userId })],
      }
    },

    SucceededFetchPreferences: ({ userId, preferences }) => {
      const cache = CachePreferences({ preferences })

      if (!Option.contains(model.maybeUserId, userId)) {
        return { model, commands: [cache] }
      }

      return {
        model: modifyFields(model, {
          maybePreferences: () => Option.some(preferences),
          draft: () => displayFieldsOf(preferences),
          source: () => 'Server',
          maybeError: () => Option.none(),
          hasSaved: () => false,
        }),
        commands: [cache],
      }
    },

    FailedFetchPreferences: ({ userId, failure }) => {
      if (!Option.contains(model.maybeUserId, userId)) {
        return { model }
      }

      // Keep whatever the cache/profile gave us; a display preference is never
      // worth blocking the screen for.
      return {
        model: modifyFields(model, {
          maybeError: () => Option.some(authErrorMessage(failure.code)),
        }),
      }
    },

    SucceededSavePreferences: ({ userId, preferences }) => {
      const cache = CachePreferences({ preferences })

      if (!Option.contains(model.maybeUserId, userId)) {
        return { model, commands: [cache] }
      }

      return {
        model: modifyFields(model, {
          maybePreferences: () => Option.some(preferences),
          draft: () => displayFieldsOf(preferences),
          source: () => 'Server',
          isSaving: () => false,
          hasSaved: () => true,
          maybeError: () => Option.none(),
        }),
        commands: [cache],
      }
    },

    FailedSavePreferences: ({ userId, failure }) => {
      if (!Option.contains(model.maybeUserId, userId)) {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isSaving: () => false,
          hasSaved: () => false,
          maybeError: () => Option.some(authErrorMessage(failure.code)),
        }),
      }
    },

    UpdatedTimeZoneDraft: ({ value }) => ({
      model: modifyFields(model, {
        draft: () => modifyFields(model.draft, { timeZone: () => value }),
        hasSaved: () => false,
        maybeError: () => Option.none(),
      }),
    }),

    UpdatedWeekStartDraft: ({ value }) => ({
      model: modifyFields(model, {
        draft: () => modifyFields(model.draft, { weekStart: () => value }),
        hasSaved: () => false,
        maybeError: () => Option.none(),
      }),
    }),

    UpdatedDigitsDraft: ({ value }) => ({
      model: modifyFields(model, {
        draft: () => modifyFields(model.draft, { digits: () => value }),
        hasSaved: () => false,
        maybeError: () => Option.none(),
      }),
    }),

    SubmittedDisplayPreferences: () => {
      if (model.isSaving) {
        return { model }
      }

      const userId = Option.getOrUndefined(model.maybeUserId)

      if (userId === undefined) {
        return {
          model: modifyFields(model, {
            maybeError: () => Option.some(authErrorMessage('Unauthorized')),
          }),
        }
      }

      const trimmedDraft = modifyFields(model.draft, {
        timeZone: () => model.draft.timeZone.trim(),
      })

      if (!isIanaTimeZone(trimmedDraft.timeZone)) {
        return {
          model: modifyFields(model, {
            hasSaved: () => false,
            maybeError: () => Option.some(invalidTimeZoneMessage),
          }),
        }
      }

      return {
        model: modifyFields(model, {
          draft: () => trimmedDraft,
          isSaving: () => true,
          hasSaved: () => false,
          maybeError: () => Option.none(),
        }),
        commands: [
          SavePreferences({
            userId,
            patch: changedDisplayFields(
              confirmedDisplayFields(model),
              trimmedDraft,
            ),
          }),
        ],
      }
    },

    ClickedRefreshPreferences: () =>
      Option.match(model.maybeUserId, {
        onNone: () => ({ model }),
        onSome: userId => ({
          model: modifyFields(model, { maybeError: () => Option.none() }),
          commands: [FetchPreferences({ userId })],
        }),
      }),

    CompletedCachePreferences: () => ({ model }),
  })

// VIEW

const TIME_ZONE_SUGGESTIONS: ReadonlyArray<string> = [
  'Asia/Tehran',
  'Asia/Dubai',
  'Asia/Istanbul',
  'Asia/Kabul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
]

const WEEK_START_OPTIONS: ReadonlyArray<{ value: WeekStart; label: string }> = [
  { value: 'saturday', label: 'شنبه' },
  { value: 'sunday', label: 'یکشنبه' },
  { value: 'monday', label: 'دوشنبه' },
]

const DIGITS_OPTIONS: ReadonlyArray<{ value: Digits; label: string }> = [
  { value: 'persian', label: 'فارسی (۱۲۳)' },
  { value: 'latin', label: 'لاتین (123)' },
]

const SOURCE_COPY: Readonly<
  Record<
    PreferencesSource,
    Readonly<{ label: string; badgeClass: string; hint: string }>
  >
> = {
  Default: {
    label: 'مقادیر پیش‌فرض',
    badgeClass: 'badge-ghost',
    hint: 'هنوز تنظیمات ذخیره‌شده‌ای از سرور خوانده نشده است.',
  },
  Cache: {
    label: 'از حافظه‌ی محلی',
    badgeClass: 'badge-warning',
    hint: 'آخرین مقدار تأییدشده روی همین دستگاه نمایش داده می‌شود؛ با اتصال، سرور آن را تازه می‌کند.',
  },
  Server: {
    label: 'همگام با سرور',
    badgeClass: 'badge-success',
    hint: 'این مقدار آخرین پاسخ سرور است و روی همه‌ی دستگاه‌ها یکی می‌شود.',
  },
}

const sourceCopy = (
  source: PreferencesSource,
): Readonly<{ label: string; badgeClass: string; hint: string }> =>
  SOURCE_COPY[source]

const successView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.hasSaved
    ? h.div(
        [
          h.Role('status'),
          h.Class(
            'alert alert-success items-start gap-2 py-2.5 text-sm leading-7',
          ),
        ],
        [h.span([], ['تنظیمات نمایش ذخیره شد.'])],
      )
    : h.empty

const timeZoneFieldView = (model: Model, h: HtmlBuilder<Message>): Html =>
  fieldView(
    {
      id: 'settings-timezone',
      label: 'منطقه‌ی زمانی (IANA)',
      hint: 'مثل Asia/Tehran',
      children: [
        textInputView(
          {
            id: 'settings-timezone',
            name: 'timeZone',
            dir: 'ltr',
            autoComplete: 'off',
            listId: 'settings-timezone-options',
            value: model.draft.timeZone,
            isDisabled: model.isSaving,
            onInput: value => Message.UpdatedTimeZoneDraft({ value }),
          },
          h,
        ),
        h.datalist(
          [h.Id('settings-timezone-options')],
          TIME_ZONE_SUGGESTIONS.map(zone => h.option([h.Value(zone)])),
        ),
      ],
    },
    h,
  )

export const settingsView = Submodel.defineView<Model, Message>((model, h) => {
  const source = sourceCopy(model.source)

  return h.section(
    [
      h.AriaLabelledBy('settings-display-title'),
      h.Class('panel grid gap-4 p-4 sm:p-5'),
    ],
    [
      h.header(
        [h.Class('grid gap-1')],
        [
          h.div(
            [h.Class('flex flex-wrap items-center justify-between gap-2')],
            [
              h.h2(
                [
                  h.Id('settings-display-title'),
                  h.Class('m-0 text-lg font-bold'),
                ],
                ['نمایش'],
              ),
              h.span(
                [h.Class(`badge badge-sm ${source.badgeClass}`)],
                [source.label],
              ),
            ],
          ),
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            ['تقویم شمسی، شروع هفته و شکل اعداد را اینجا تغییر دهید.'],
          ),
          h.p(
            [h.Class('m-0 text-[0.78rem] leading-7 text-base-content/45')],
            [source.hint],
          ),
        ],
      ),
      h.form(
        [
          h.Class('grid gap-3.5'),
          h.OnSubmit(Message.SubmittedDisplayPreferences()),
        ],
        [
          timeZoneFieldView(model, h),
          fieldView(
            {
              id: 'settings-week-start',
              label: 'شروع هفته',
              children: [
                selectInputView(
                  {
                    id: 'settings-week-start',
                    name: 'weekStart',
                    value: model.draft.weekStart,
                    options: WEEK_START_OPTIONS,
                    isDisabled: model.isSaving,
                    onChange: value =>
                      Message.UpdatedWeekStartDraft({
                        value: weekStartOf(value),
                      }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
          fieldView(
            {
              id: 'settings-digits',
              label: 'شکل اعداد',
              children: [
                selectInputView(
                  {
                    id: 'settings-digits',
                    name: 'digits',
                    value: model.draft.digits,
                    options: DIGITS_OPTIONS,
                    isDisabled: model.isSaving,
                    onChange: value =>
                      Message.UpdatedDigitsDraft({ value: digitsOf(value) }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
          formErrorView(model.maybeError, h),
          successView(model, h),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              buttonView(
                {
                  type: 'submit',
                  class: 'flex-1',
                  isDisabled: model.isSaving,
                  isLoading: model.isSaving,
                  children: ['ذخیره‌ی تنظیمات نمایش'],
                },
                h,
              ),
              buttonView(
                {
                  type: 'button',
                  variant: 'ghost',
                  isDisabled: model.isSaving,
                  children: ['تازه‌سازی'],
                  onClick: Message.ClickedRefreshPreferences(),
                },
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  )
})
