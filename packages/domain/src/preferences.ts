import { Schema } from "effect"
import { Model } from "effect/schema"
import { Digits, UserId, WeekStart } from "./common.js"
import { DEFAULT_DIGITS } from "./digits.js"
import { DEFAULT_TIME_ZONE } from "./jalali.js"
import { ListCheckedPlacement, TimeZone } from "./planning/common.js"

/**
 * Per-user display preferences (ticket #35).
 *
 * These are **not** syncable common items: a preference row is small, changes
 * when the user edits settings, and is owned by exactly one user. The server
 * is the source of truth and the client keeps a read-only cache for offline
 * boot (`docs/adr/0002-preferences-server-of-record-local-cache.md`), so these
 * shapes carry no `version`/`ownerId`/`deletedAt` contract and never enter the
 * sync outbox.
 *
 * Defaults are Persian-first (CC-04): Saturday week start, Persian digits, the
 * feature map's dashboard order, and checked list items at the bottom.
 */

/** Dashboard sections, in the product's default order (FR-VIEW-01). */
export const DASHBOARD_SECTIONS = [
  "tasks",
  "events",
  "reminders",
  "habits",
  "notes"
] as const

export const DashboardSection = Schema.Literals(DASHBOARD_SECTIONS)
export type DashboardSection = Schema.Schema.Type<typeof DashboardSection>

export const DEFAULT_DASHBOARD_SECTION_ORDER: ReadonlyArray<DashboardSection> =
  DASHBOARD_SECTIONS

export const DEFAULT_WEEK_START: WeekStart = "saturday"
export const DEFAULT_DIGITS_STYLE: Digits = DEFAULT_DIGITS
export const DEFAULT_CHECKED_ITEM_PLACEMENT: ListCheckedPlacement = "bottom"

/**
 * A dashboard order is a full permutation: every known section exactly once.
 *
 * Storing a complete order (rather than a sparse "priority" list) means the
 * array round-trips verbatim today, before the dashboard consumes it, and a
 * later reordering UI only has to send the seven (eventually) known ids.
 */
const isDashboardSectionOrder = Schema.makeFilter<ReadonlyArray<DashboardSection>>(
  (sections) => {
    if (sections.length !== DASHBOARD_SECTIONS.length) {
      return `must contain all ${DASHBOARD_SECTIONS.length} dashboard sections`
    }
    const unique = new Set(sections)
    if (unique.size !== sections.length) {
      return "must not repeat a dashboard section"
    }
    return DASHBOARD_SECTIONS.every((section) => unique.has(section))
      ? true
      : "must contain only known dashboard sections"
  }
)

export const DashboardSectionOrder = Schema.Array(DashboardSection).check(
  isDashboardSectionOrder
)
export type DashboardSectionOrder = Schema.Schema.Type<typeof DashboardSectionOrder>

/**
 * Defensive display order for consumers reading a possibly stale cache.
 *
 * A persisted order is validated as a full permutation, but a browser can hold
 * an older cached value across a release that adds a section. Drop unknown and
 * duplicate ids, then append any missing known section in product order — so
 * `Today` always renders every section exactly once instead of silently
 * hiding a new one.
 */
export const normalizeDashboardSectionOrder = (
  order: ReadonlyArray<string> | undefined
): ReadonlyArray<DashboardSection> => {
  const seen = new Set<DashboardSection>()
  const result: Array<DashboardSection> = []
  for (const candidate of order ?? []) {
    if (!(DASHBOARD_SECTIONS as ReadonlyArray<string>).includes(candidate)) continue
    const section = candidate as DashboardSection
    if (seen.has(section)) continue
    seen.add(section)
    result.push(section)
  }
  for (const section of DASHBOARD_SECTIONS) {
    if (!seen.has(section)) result.push(section)
  }
  return result
}

export class UserPreferences extends Model.Class<UserPreferences>("UserPreferences")({
  userId: UserId,
  /** IANA zone used for "today", week boundaries and all-day dates. */
  timeZone: TimeZone,
  weekStart: WeekStart,
  digits: Digits,
  dashboardSectionOrder: DashboardSectionOrder,
  checkedItemPlacement: ListCheckedPlacement,
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

/** `GET /preferences` and `PATCH /preferences` body. */
export const PreferencesResponse = Schema.Struct({ preferences: UserPreferences })
export type PreferencesResponse = Schema.Schema.Type<typeof PreferencesResponse>

/**
 * A partial update: only the fields the client changed. Omitted fields keep
 * their stored value (or the default when no row exists yet).
 */
export const PreferencesPatch = Schema.Struct({
  timeZone: Schema.optional(TimeZone),
  weekStart: Schema.optional(WeekStart),
  digits: Schema.optional(Digits),
  dashboardSectionOrder: Schema.optional(DashboardSectionOrder),
  checkedItemPlacement: Schema.optional(ListCheckedPlacement)
})
export type PreferencesPatch = Schema.Schema.Type<typeof PreferencesPatch>

export interface PreferenceDefaults {
  readonly timeZone?: string
  readonly weekStart?: WeekStart
  readonly digits?: Digits
}

/**
 * The values served before a row exists. The time zone (and, when supplied,
 * the registered profile's week start/digits) come from the account so a user
 * who signed up in Berlin is not silently moved to Tehran on first settings
 * visit; everything else uses the Persian-first defaults.
 */
export const defaultPreferences = (
  userId: UserId,
  defaults: PreferenceDefaults = {}
): UserPreferences =>
  new UserPreferences({
    userId,
    timeZone: defaults.timeZone ?? DEFAULT_TIME_ZONE,
    weekStart: defaults.weekStart ?? DEFAULT_WEEK_START,
    digits: defaults.digits ?? DEFAULT_DIGITS_STYLE,
    dashboardSectionOrder: DEFAULT_DASHBOARD_SECTION_ORDER,
    checkedItemPlacement: DEFAULT_CHECKED_ITEM_PLACEMENT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  })
