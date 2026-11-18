import fc from 'fast-check'
import { Temporal } from 'temporal-polyfill/full'
import { describe, expect, it } from 'vite-plus/test'
import { addLocalDays } from '../local-date.js'
import { SEED, arbRule, isoDate } from '../property-helpers.js'
import { occurrenceDates } from '../recurrence.js'
import {
  eventOccurrences,
  localDayBefore,
  type EventOccurrenceSource,
} from './event-recurrence.js'
import type { EventException } from './event.js'

/**
 * Ticket #118 — property laws for the event recurrence projection.
 *
 * The laws pin the expansion contract of `event-recurrence.ts` at the pure
 * seam: a window shows exactly the occurrences the shared engine generates
 * (plus the anchor row and any real occurrence an exception names), one
 * occurrence per key — an exception never duplicates a key — every shown
 * occurrence is painted inside the window, a delete only removes, and an
 * override replaces its occurrence in place.
 *
 * The exception-set laws use all-day timing in the event's own zone, so an
 * occurrence's display date is its key and the expected set can be computed
 * from the engine alone. The containment law also covers timed series,
 * whose display date may shift a day in the viewer's zone.
 */

const TEHRAN = 'Asia/Tehran'
const CREATED_AT = '2026-01-01T00:00:00.000Z'

interface SeriesCase {
  readonly rule: NonNullable<EventOccurrenceSource['recurrence']>
  readonly start: string
  readonly from: string
  readonly to: string
  readonly exceptions: ReadonlyArray<EventException>
}

/**
 * A series, a window of up to ~200 days around it, and exceptions sampled
 * from the series' real occurrence dates plus noise dates that are not
 * occurrences (the wire pattern admits those; they must be ignored).
 */
const arbSeriesCase: fc.Arbitrary<SeriesCase> = fc
  .record({
    rule: arbRule,
    anchor: fc.integer({ min: 0, max: 1300 }),
    fromDelta: fc.integer({ min: -30, max: 90 }),
    span: fc.integer({ min: 0, max: 200 }),
  })
  .chain(({ rule, anchor, fromDelta, span }) => {
    const start = isoDate(anchor)
    const fromOffset = Math.max(0, anchor + fromDelta)
    const from = isoDate(fromOffset)
    const to = isoDate(fromOffset + span)
    const seriesDates = occurrenceDates(rule, start)
    return fc
      .record({
        realPicks:
          seriesDates.length > 0
            ? fc.uniqueArray(
                fc.integer({ min: 0, max: seriesDates.length - 1 }),
                {
                  maxLength: 6,
                },
              )
            : fc.constant([] as number[]),
        noise: fc.uniqueArray(
          fc.integer({ min: fromOffset, max: fromOffset + span }),
          {
            maxLength: 3,
          },
        ),
      })
      .chain(({ realPicks, noise }) => {
        const keys = [
          ...new Set([
            ...realPicks.map(pick => seriesDates[pick]!),
            ...noise.map(offset => isoDate(offset)),
          ]),
        ]
        return fc
          .array(fc.constantFrom('delete', 'override'), {
            minLength: keys.length,
            maxLength: keys.length,
          })
          .map(actions => ({
            rule,
            start,
            from,
            to,
            exceptions: keys.map((key, index) => ({
              id: `exc-${index}`,
              instanceId: key,
              action: actions[index]!,
              overrides:
                actions[index] === 'override'
                  ? { title: `عنوان ${index}` }
                  : null,
              createdAt: CREATED_AT,
            })) as EventException[],
          }))
      })
  })

const allDaySeries = (caseValue: {
  readonly rule: SeriesCase['rule']
  readonly start: string
  readonly exceptions?: ReadonlyArray<EventException>
}): EventOccurrenceSource => ({
  id: 'event-1',
  title: 'رویداد',
  description: null,
  location: null,
  category: null,
  color: null,
  people: [],
  timing: { _tag: 'allDay', date: caseValue.start },
  timeZone: TEHRAN,
  recurrence: caseValue.rule,
  exceptions: caseValue.exceptions ?? [],
})

/** `instanceId === anchor`, or the engine generates it (the engine's own definition, reused as the oracle). */
const isSeriesOccurrence = (
  series: EventOccurrenceSource,
  key: string,
): boolean => {
  const anchor = series.timing._tag === 'allDay' ? series.timing.date : ''
  if (key === anchor) return true
  if (series.recurrence === null) return false
  return occurrenceDates(series.recurrence, anchor, {
    from: key,
    to: key,
  }).includes(key)
}

/**
 * The occurrence keys the contract says a window holds: the anchor, the
 * engine's windowed expansion (padded a day each side for display shifts),
 * and any exception that names a real occurrence — minus the deleted ones,
 * filtered to the display window. All-day + same zone ⇒ display date == key.
 */
const expectedInstanceIds = (
  series: EventOccurrenceSource,
  from: string,
  to: string,
): ReadonlyArray<string> => {
  const anchor = series.timing._tag === 'allDay' ? series.timing.date : ''
  const ids = new Set<string>([anchor])
  if (series.recurrence !== null) {
    for (const date of occurrenceDates(series.recurrence, anchor, {
      from: localDayBefore(from),
      to: addLocalDays(to, 1),
    })) {
      ids.add(date)
    }
  }
  for (const exception of series.exceptions) {
    if (isSeriesOccurrence(series, exception.instanceId))
      ids.add(exception.instanceId)
  }
  for (const exception of series.exceptions) {
    if (exception.action === 'delete') ids.delete(exception.instanceId)
  }
  return [...ids].filter(id => id >= from && id <= to).sort()
}

describe('eventOccurrences (property laws)', () => {
  it('projects exactly the series occurrences in the window, one key each', () => {
    fc.assert(
      fc.property(arbSeriesCase, caseValue => {
        const series = allDaySeries(caseValue)
        const occurrences = eventOccurrences({
          events: [series],
          from: caseValue.from,
          to: caseValue.to,
          timeZone: TEHRAN,
        })

        const keys = occurrences.map(occurrence => occurrence.instanceId)
        // One occurrence per key: an exception never duplicates a key, and
        // the same series is never painted twice.
        expect(new Set(keys).size).toBe(keys.length)
        expect(keys).toEqual(
          expectedInstanceIds(series, caseValue.from, caseValue.to),
        )

        for (const occurrence of occurrences) {
          // Every shown occurrence is painted inside the window.
          expect(occurrence.date >= caseValue.from).toBe(true)
          expect(occurrence.date <= caseValue.to).toBe(true)
          // The anchor row keeps its own key; generated occurrences are
          // addressed by `id@instanceId`.
          expect(occurrence.key).toBe(
            occurrence.instanceId === caseValue.start
              ? series.id
              : `${series.id}@${occurrence.instanceId}`,
          )
        }
        // The projection is display-date sorted.
        for (let index = 1; index < occurrences.length; index += 1) {
          expect(occurrences[index]!.date >= occurrences[index - 1]!.date).toBe(
            true,
          )
        }
      }),
      { seed: SEED, numRuns: 60 },
    )
  })

  it('a delete exception removes its occurrence without shifting the schedule', () => {
    fc.assert(
      fc.property(arbSeriesCase, caseValue => {
        const projected = eventOccurrences({
          events: [allDaySeries(caseValue)],
          from: caseValue.from,
          to: caseValue.to,
          timeZone: TEHRAN,
        })
        const bare = eventOccurrences({
          events: [allDaySeries({ ...caseValue, exceptions: [] })],
          from: caseValue.from,
          to: caseValue.to,
          timeZone: TEHRAN,
        })
        const deleted = new Set(
          caseValue.exceptions
            .filter(exception => exception.action === 'delete')
            .map(exception => exception.instanceId),
        )
        expect(projected.map(occurrence => occurrence.instanceId)).toEqual(
          bare
            .map(occurrence => occurrence.instanceId)
            .filter(key => !deleted.has(key)),
        )
      }),
      { seed: SEED, numRuns: 60 },
    )
  })

  it('an override exception replaces its occurrence in place', () => {
    fc.assert(
      fc.property(arbSeriesCase, caseValue => {
        const series = allDaySeries(caseValue)
        const occurrences = eventOccurrences({
          events: [series],
          from: caseValue.from,
          to: caseValue.to,
          timeZone: TEHRAN,
        })
        const expected = expectedInstanceIds(
          series,
          caseValue.from,
          caseValue.to,
        )
        for (const exception of caseValue.exceptions) {
          if (exception.action !== 'override') continue
          if (!expected.includes(exception.instanceId)) continue
          const occurrence = occurrences.find(
            candidate => candidate.instanceId === exception.instanceId,
          )
          expect(occurrence).toBeDefined()
          expect(occurrence!.overridden).toBe(true)
          expect(occurrence!.exceptionId).toBe(exception.id)
          expect(occurrence!.title).toBe(exception.overrides!.title)
        }
      }),
      { seed: SEED, numRuns: 60 },
    )
  })

  it('keeps every occurrence inside the window for timed series too', () => {
    const arbTimedCase = fc
      .record({
        rule: fc.option(arbRule, { nil: null }),
        anchor: fc.integer({ min: 0, max: 1300 }),
        hour: fc.integer({ min: 0, max: 23 }),
        fromDelta: fc.integer({ min: -30, max: 60 }),
        span: fc.integer({ min: 0, max: 120 }),
        viewerZone: fc.constantFrom('UTC', TEHRAN),
      })
      .map(({ rule, anchor, hour, fromDelta, span, viewerZone }) => {
        const day = isoDate(anchor)
        const startInstant = Temporal.PlainDate.from(day)
          .toPlainDateTime(
            Temporal.PlainTime.from(`${String(hour).padStart(2, '0')}:00`),
          )
          .toZonedDateTime(TEHRAN, { disambiguation: 'compatible' })
          .toInstant()
        const endInstant = startInstant.add({ hours: 1 })
        const fromOffset = Math.max(0, anchor + fromDelta)
        return {
          series: {
            id: 'event-1',
            title: 'جلسه',
            description: null,
            location: null,
            category: null,
            color: null,
            people: [],
            timing: {
              _tag: 'timed' as const,
              start: new Date(startInstant.epochMilliseconds).toISOString(),
              end: new Date(endInstant.epochMilliseconds).toISOString(),
            },
            timeZone: TEHRAN,
            recurrence: rule,
            exceptions: [],
          },
          from: isoDate(fromOffset),
          to: isoDate(fromOffset + span),
          viewerZone,
        }
      })

    fc.assert(
      fc.property(arbTimedCase, ({ series, from, to, viewerZone }) => {
        const occurrences = eventOccurrences({
          events: [series],
          from,
          to,
          timeZone: viewerZone,
        })
        // A timed occurrence may paint on the previous/next day in the
        // viewer's zone; whatever day it paints on is inside the window.
        for (const occurrence of occurrences) {
          expect(occurrence.date >= from).toBe(true)
          expect(occurrence.date <= to).toBe(true)
          expect(occurrence.recurring).toBe(series.recurrence !== null)
        }
        const keys = occurrences.map(occurrence => occurrence.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (let index = 1; index < occurrences.length; index += 1) {
          expect(occurrences[index]!.date >= occurrences[index - 1]!.date).toBe(
            true,
          )
        }
      }),
      { seed: SEED, numRuns: 60 },
    )
  })
})
