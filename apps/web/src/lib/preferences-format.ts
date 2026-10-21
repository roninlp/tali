import {
  jalaliWeek,
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  localizeDigits,
  toJalaliFields,
  type UserPreferences
} from "@tali/domain"

/**
 * Preference-driven week rendering for `/today` (ticket #35).
 *
 * A single place where `weekStart` and `digits` turn into the seven cells the
 * dashboard shows, so the screen re-renders from the preferences signal
 * without re-deriving calendar logic. The week is Jalali; weekdays are named
 * in Persian and only the numerals are localized (weekday names contain no
 * digits).
 */

type JalaliDate = Parameters<typeof jalaliWeek>[0]

export interface WeekDay {
  readonly date: JalaliDate
  /** ISO wall date (`YYYY-MM-DD`), a stable key for `For`. */
  readonly key: string
  readonly weekday: string
  /** Single-letter weekday for narrow cells; the full name is in `label`. */
  readonly shortWeekday: string
  /** Localized day number, e.g. `۱۵` or `15`. */
  readonly day: string
  readonly month: string
  /** `weekday day month`, localized — an accessible label for the cell. */
  readonly label: string
  readonly isToday: boolean
}

export type WeekRenderingPreferences = Pick<UserPreferences, "weekStart" | "digits">

/** The seven Jalali days of `today`'s week, honoring the saved preferences. */
export const weekDaysFor = (
  today: JalaliDate,
  preferences: WeekRenderingPreferences
): ReadonlyArray<WeekDay> =>
  jalaliWeek(today, preferences.weekStart).map((date) => {
    const fields = toJalaliFields(date)
    const weekday = JALALI_WEEKDAYS[date.withCalendar("iso8601").dayOfWeek - 1] ?? ""
    const month = JALALI_MONTHS[fields.month - 1] ?? ""
    const day = localizeDigits(fields.day, preferences.digits)
    return {
      date,
      key: date.withCalendar("iso8601").toString(),
      weekday,
      shortWeekday: weekday.charAt(0),
      day,
      month,
      label: `${weekday} ${day} ${month}`,
      isToday: date.equals(today)
    }
  })
