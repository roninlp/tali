import { Schema } from 'effect'

/**
 * Per-user display preferences as the Foldkit Model holds them.
 *
 * This is a local plain projection of `@tali/domain`'s `UserPreferences`, for
 * the same reason `Session` is: the API response is decoded by the app's own
 * Schema runtime, so no branded value crosses the module boundary Vite's dev
 * optimizer creates for `effect/schema`. The server stays the source of
 * truth; the browser only keeps a read cache (ADR-0002).
 */

export const WeekStart = Schema.Literals(['saturday', 'sunday', 'monday'])

export type WeekStart = typeof WeekStart.Type

export const Digits = Schema.Literals(['persian', 'latin'])

export type Digits = typeof Digits.Type

export const CheckedItemPlacement = Schema.Literals(['inPlace', 'bottom'])

export type CheckedItemPlacement = typeof CheckedItemPlacement.Type

export const Preferences = Schema.Struct({
  userId: Schema.String,
  timeZone: Schema.String,
  weekStart: WeekStart,
  digits: Digits,
  dashboardSectionOrder: Schema.Array(Schema.String),
  checkedItemPlacement: CheckedItemPlacement,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

export type Preferences = typeof Preferences.Type

export const PreferencesPatch = Schema.Struct({
  timeZone: Schema.optional(Schema.String),
  weekStart: Schema.optional(WeekStart),
  digits: Schema.optional(Digits),
  dashboardSectionOrder: Schema.optional(Schema.Array(Schema.String)),
  checkedItemPlacement: Schema.optional(CheckedItemPlacement),
})

export type PreferencesPatch = typeof PreferencesPatch.Type

/** Where the value currently on screen came from. */
export const PreferencesSource = Schema.Literals(['Default', 'Cache', 'Server'])

export type PreferencesSource = typeof PreferencesSource.Type

/** The three fields the display-settings form edits on one save. */
export const DisplayFields = Schema.Struct({
  timeZone: Schema.String,
  weekStart: WeekStart,
  digits: Digits,
})

export type DisplayFields = typeof DisplayFields.Type

/** The profile values a user who never saved preferences should see. */
export type PreferenceDefaults = Readonly<{
  timeZone?: string
  weekStart?: WeekStart
  digits?: Digits
}>

export const DEFAULT_TIME_ZONE = 'Asia/Tehran'
export const DEFAULT_WEEK_START: WeekStart = 'saturday'
export const DEFAULT_DIGITS: Digits = 'persian'

export const DEFAULT_DASHBOARD_ORDER: ReadonlyArray<string> = [
  'tasks',
  'events',
  'reminders',
  'habits',
  'notes',
]

/** Fallback display settings, matching `defaultPreferences` in the domain. */
export const defaultPreferences = (
  userId: string,
  defaults: PreferenceDefaults = {},
): Preferences =>
  Preferences.make({
    userId,
    timeZone: defaults.timeZone ?? DEFAULT_TIME_ZONE,
    weekStart: defaults.weekStart ?? DEFAULT_WEEK_START,
    digits: defaults.digits ?? DEFAULT_DIGITS,
    dashboardSectionOrder: DEFAULT_DASHBOARD_ORDER,
    checkedItemPlacement: 'bottom',
    // Timestamps are server-owned. Defaults only render before the first read.
    createdAt: '',
    updatedAt: '',
  })

export const displayFieldsOf = (preferences: Preferences): DisplayFields =>
  DisplayFields.make({
    timeZone: preferences.timeZone,
    weekStart: preferences.weekStart,
    digits: preferences.digits,
  })

/** The display fields a save may change; a type alias, not an interface. */
type DisplayFieldsPatch = {
  timeZone?: string
  weekStart?: WeekStart
  digits?: Digits
}

/**
 * The PATCH for a display-settings save: only the fields whose draft differs
 * from the last value this device has confirmed.
 *
 * Sending the whole form would re-persist drafts that were never confirmed
 * here — the profile defaults while the first `GET` is still in flight, or a
 * cache another device has since outgrown — over the untouched fields. That is
 * the silent revert ADR-0002 rules out. Omitted fields keep their stored value
 * server-side, and an empty patch just returns the authoritative row (which
 * also corrects a stale draft).
 */
export const changedDisplayFields = (
  saved: DisplayFields,
  draft: DisplayFields,
): PreferencesPatch => {
  const patch: DisplayFieldsPatch = {}

  if (draft.timeZone !== saved.timeZone) {
    patch.timeZone = draft.timeZone
  }

  if (draft.weekStart !== saved.weekStart) {
    patch.weekStart = draft.weekStart
  }

  if (draft.digits !== saved.digits) {
    patch.digits = draft.digits
  }

  return patch
}
