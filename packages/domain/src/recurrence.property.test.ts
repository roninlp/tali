import fc from 'fast-check'
import { Schema } from 'effect'
import { Temporal } from 'temporal-polyfill/full'
import { describe, expect, it } from 'vite-plus/test'
import { SEED, arbRule, compact, isoDate } from './property-helpers.js'
import {
  MAX_OCCURRENCES,
  RecurrenceRule,
  nextOccurrence,
  occurrenceDates,
  type RecurrenceRule as RecurrenceRuleType,
} from './recurrence.js'

/**
 * Ticket #118 — property laws for the hand-rolled recurrence engine.
 *
 * Each law replays a clause of the module's documented contract (the "Rule
 * semantics" section of `recurrence.ts`): candidates are period-sorted and
 * never precede the anchor; a window never changes which dates are
 * occurrences, only which are returned; exceptions are removed after
 * generation so they cannot shift the schedule or extend a `count`; and a
 * rule that can never match is bounded by `MAX_PERIODS` instead of looping.
 *
 * Windows are kept under ~900 days so an expansion stays below the default
 * `MAX_OCCURRENCES` limit and whole-suite runtime stays in the seconds.
 */

/**
 * A rule, an anchor and a `[from, to]` window around it. `to` is at most 900
 * days past the anchor and `from` may sit before it, exercising the
 * "skipped but still counted" lower bound.
 */
const arbWindowed = fc
  .record({
    rule: arbRule,
    anchor: fc.integer({ min: 0, max: 1300 }),
    span: fc.integer({ min: 0, max: 900 }),
  })
  .chain(({ rule, anchor, span }) =>
    fc
      .integer({ min: Math.max(0, anchor - 400), max: anchor + span })
      .map(from => ({
        rule,
        start: isoDate(anchor),
        from: isoDate(from),
        to: isoDate(anchor + span),
      })),
  )

/** A count-bounded rule plus occurrence dates to except. */
const arbCountedExceptions = fc
  .record({
    rule: arbRule,
    count: fc.integer({ min: 1, max: 40 }),
    anchor: fc.integer({ min: 0, max: 1300 }),
  })
  .chain(({ rule, count, anchor }) =>
    fc
      .uniqueArray(fc.integer({ min: 0, max: 400 }), { maxLength: 12 })
      .map(offsets => ({
        rule: compact({
          ...rule,
          end: { _tag: 'count', count },
        }) as RecurrenceRuleType,
        start: isoDate(anchor),
        exceptions: offsets.map(offset => isoDate(anchor + offset)),
      })),
  )

describe('recurrence expansion (property laws)', () => {
  it('is strictly increasing, duplicate-free, and inside every bound', () => {
    fc.assert(
      fc.property(arbWindowed, ({ rule, start, from, to }) => {
        // The generator only builds schema-valid rules; pin that down so a
        // future edit to it cannot silently test invalid inputs.
        expect(Schema.is(RecurrenceRule)(rule)).toBe(true)

        const occurrences = occurrenceDates(rule, start, { from, to })
        expect(occurrences.length).toBeLessThanOrEqual(MAX_OCCURRENCES)
        for (const [index, date] of occurrences.entries()) {
          // Candidates before the anchor are dropped, so nothing escapes
          // the series' own start.
          expect(date >= start).toBe(true)
          expect(date >= from).toBe(true)
          expect(date <= to).toBe(true)
          if (rule.end._tag === 'until')
            expect(date <= rule.end.date).toBe(true)
          // Candidates within a period are sorted and periods increase.
          if (index > 0) expect(date > occurrences[index - 1]).toBe(true)
        }
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('returns exactly the rule occurrences that fall inside the window', () => {
    fc.assert(
      fc.property(arbWindowed, ({ rule, start, from, to }) => {
        // A window may not invent or lose occurrences: expanding [from, to]
        // is the same expansion as expanding [.., to] and keeping ≥ from
        // (earlier occurrences are skipped, never regenerated differently).
        expect(occurrenceDates(rule, start, { from, to })).toEqual(
          occurrenceDates(rule, start, { to }).filter(date => date >= from),
        )
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('counts pre-exception occurrences, and exceptions only ever remove', () => {
    fc.assert(
      fc.property(arbCountedExceptions, ({ rule, start, exceptions }) => {
        expect(Schema.is(RecurrenceRule)(rule)).toBe(true)
        const count = rule.end._tag === 'count' ? rule.end.count : 0
        const base = occurrenceDates(rule, start)
        // `count` caps the occurrences generated before exceptions (RFC 5545).
        expect(base.length).toBeLessThanOrEqual(count)
        // An exception removes its date; it never shifts the schedule or
        // extends the count budget.
        expect(occurrenceDates(rule, start, { exceptions })).toEqual(
          base.filter(date => !exceptions.includes(date)),
        )
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('bounds a rule that can never match instead of looping', () => {
    // A yearly rule pinned to the 31st of a 30-day Jalali month (months
    // 7–11) has no candidate date in any year: the MAX_PERIODS safety valve
    // must stop the walk and return no occurrences.
    const arbNeverMatching = fc.record({
      year: fc.integer({ min: 1400, max: 1420 }),
      month: fc.integer({ min: 7, max: 11 }),
      day: fc.integer({ min: 1, max: 30 }),
      interval: fc.integer({ min: 1, max: 2 }),
    })
    fc.assert(
      fc.property(arbNeverMatching, ({ year, month, day, interval }) => {
        const anchor = Temporal.PlainDate.from({
          year,
          month,
          day,
          calendar: 'persian',
        })
          .withCalendar('iso8601')
          .toString()
        expect(
          occurrenceDates(
            {
              frequency: 'yearly',
              interval,
              byMonthDay: [31],
              end: { _tag: 'never' },
            },
            anchor,
          ),
        ).toEqual([])
      }),
      // Every case walks all 20 000 periods, so keep the run count low.
      { seed: SEED, numRuns: 12 },
    )
  })

  it('caps an unbounded expansion at MAX_OCCURRENCES', () => {
    const arbUnbounded = fc.record({
      // Yearly rules are covered by the never-matching law above; the other
      // frequencies all terminate on the occurrence limit, which is the
      // bound under test here.
      rule: arbRule.filter(rule => rule.frequency !== 'yearly'),
      anchor: fc.integer({ min: 0, max: 1300 }),
    })
    fc.assert(
      fc.property(arbUnbounded, ({ rule, anchor }) => {
        expect(
          occurrenceDates(rule, isoDate(anchor)).length,
        ).toBeLessThanOrEqual(MAX_OCCURRENCES)
      }),
      { seed: SEED, numRuns: 25 },
    )
  })

  it('nextOccurrence returns the earliest occurrence strictly after its date', () => {
    fc.assert(
      fc.property(arbWindowed, ({ rule, start, from }) => {
        const next = nextOccurrence(rule, start, from)
        if (next === null) {
          // Null means the series generates nothing after `from`.
          expect(
            occurrenceDates(rule, start, {
              from: Temporal.PlainDate.from(from).add({ days: 1 }).toString(),
            }),
          ).toEqual([])
          return
        }
        const date = next.toString()
        expect(date > from).toBe(true)
        // Minimality: nothing the series generates lies strictly between
        // `from` and the returned date …
        expect(
          occurrenceDates(rule, start, {
            from: Temporal.PlainDate.from(from).add({ days: 1 }).toString(),
            to: Temporal.PlainDate.from(date).add({ days: -1 }).toString(),
          }),
        ).toEqual([])
        // … and the returned date is itself an occurrence.
        expect(occurrenceDates(rule, start, { from: date, to: date })).toEqual([
          date,
        ])
      }),
      { seed: SEED, numRuns: 50 },
    )
  })
})
