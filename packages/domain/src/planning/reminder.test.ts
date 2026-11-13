import { describe, expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { ClockTime, IsoWeekday, TimeZone } from '../common.js'
import { HabitReminderTime, HabitWeekday } from './habit.js'
import { ClockTime as ReminderClockTime } from './reminder.js'
import { IsoWeekday as ReminderIsoWeekday } from './reminder.js'
import { isClockTime, isIsoWeekday } from './reminder-service.js'

/**
 * One definition per scalar contract.
 *
 * `ClockTime`, `IsoWeekday` and `TimeZone` are owned by `src/common.ts`; the
 * planning modules re-export or alias them so their public names stay put. A
 * check on the shared schema is therefore a check on every aggregate that names
 * the scalar — the tests below prove the rules themselves, plus the identity of
 * the aliases (an accidental re-declaration would fail `toBe`).
 */
describe('shared scalar contracts', () => {
  it('ClockTime accepts a 24-hour wall clock and rejects malformed times', () => {
    expect(Schema.decodeSync(ClockTime)('09:05')).toBe('09:05')
    expect(Schema.decodeSync(ClockTime)('00:00')).toBe('00:00')
    expect(Schema.decodeSync(ClockTime)('23:59')).toBe('23:59')

    for (const invalid of ['9:05', '24:00', '23:60', '', '09:05:00']) {
      expect(() => Schema.decodeSync(ClockTime)(invalid)).toThrow()
    }
  })

  it('IsoWeekday accepts 1..7 and rejects anything outside it', () => {
    expect(Schema.decodeSync(IsoWeekday)(1)).toBe(1)
    expect(Schema.decodeSync(IsoWeekday)(7)).toBe(7)

    for (const invalid of [0, 8, 1.5, -1]) {
      expect(() => Schema.decodeSync(IsoWeekday)(invalid)).toThrow()
    }
  })

  it('TimeZone accepts a real IANA identifier and rejects an invented one', () => {
    expect(Schema.decodeSync(TimeZone)('Asia/Tehran')).toBe('Asia/Tehran')
    expect(Schema.decodeSync(TimeZone)('UTC')).toBe('UTC')

    expect(() => Schema.decodeSync(TimeZone)('Mars/Olympus')).toThrow()
  })

  it('keeps the aggregate names as aliases of the shared scalars', () => {
    expect(HabitReminderTime).toBe(ClockTime)
    expect(HabitWeekday).toBe(IsoWeekday)
    expect(ReminderClockTime).toBe(ClockTime)
    expect(ReminderIsoWeekday).toBe(IsoWeekday)
  })

  it('runs the runtime predicates on the same schema', () => {
    expect(isClockTime('09:05')).toBe(true)
    expect(isClockTime('9:05')).toBe(false)
    expect(isIsoWeekday(3)).toBe(true)
    expect(isIsoWeekday(8)).toBe(false)
  })
})
