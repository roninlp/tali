import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'
import { addLocalDays } from '../local-date.js'
import { SEED, isoDate } from '../property-helpers.js'
import type { HabitEntryStatus, HabitFrequency } from './habit.js'
import {
  habitStreak,
  streakUnitOf,
  type StreakFrequencyEra,
  type StreakInput,
  type StreakResult,
} from './habit-streak.js'

/**
 * Ticket #118 — property laws for the streak/success-rate engine.
 *
 * The laws are the documented contract of `docs/streak-algorithm.md` (§4–§5):
 * the result depends only on the entries as a set (§5.1), a `missed` entry
 * and a blank day are the same zero credit/zero weight (R1–R3), the streak
 * is the §5.4 one-pass walk over the returned periods (R8–R11, including
 * "the open period never breaks" and "best survives a unit change"), and a
 * habit with no crediting entry has no streak at all.
 *
 * Inputs are the well-formed shapes #63 produces: era 0 starts at
 * `startedOn`, boundaries are strictly increasing and never in the future,
 * and one entry per local date (§4.3 makes duplicates a contract violation,
 * so the generator never produces them).
 */

type Case = {
  readonly startedOn: string
  readonly today: string
  readonly eras: ReadonlyArray<StreakFrequencyEra>
  readonly entries: ReadonlyArray<{
    localDate: string
    status: HabitEntryStatus
  }>
  readonly windowDays: 7 | 30 | 90
}

const arbFrequency: fc.Arbitrary<HabitFrequency> = fc.oneof(
  fc.constant({ _tag: 'daily' } as const),
  fc
    .uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 })
    .map(days => ({ _tag: 'weekdays' as const, days })),
  fc
    .integer({ min: 1, max: 7 })
    .map(times => ({ _tag: 'weekly' as const, times })),
)

const arbStatus = fc.constantFrom('done', 'partial', 'missed')

/**
 * A habit lifetime of at most ~150 days (so each run walks at most ~150
 * periods), up to three frequency eras, and up to 40 unique entries — some
 * of them deliberately outside `[startedOn, today]`, which the engine must
 * ignore (§4.2).
 */
const arbCase: fc.Arbitrary<Case> = fc
  .record({
    startedOn: fc.integer({ min: 0, max: 600 }),
    span: fc.integer({ min: 0, max: 150 }),
    eraCount: fc.integer({ min: 1, max: 3 }),
    windowDays: fc.constantFrom(7, 30, 90),
  })
  .chain(({ startedOn, span, eraCount, windowDays }) => {
    const today = startedOn + span
    const arbBoundaries =
      span > 0
        ? fc.uniqueArray(fc.integer({ min: startedOn + 1, max: today }), {
            maxLength: 2,
          })
        : fc.constant([] as number[])
    return arbBoundaries.chain(boundaries => {
      const eraBoundaries = [...boundaries]
        .sort((a, b) => a - b)
        .slice(0, Math.max(0, eraCount - 1))
      return fc
        .array(arbFrequency, {
          minLength: eraBoundaries.length + 1,
          maxLength: eraBoundaries.length + 1,
        })
        .chain(frequencies =>
          fc
            .uniqueArray(
              fc.record({
                offset: fc.integer({ min: 0, max: today + 30 }),
                status: arbStatus,
              }),
              { selector: entry => entry.offset, maxLength: 40 },
            )
            .map(entries => ({
              startedOn: isoDate(startedOn),
              today: isoDate(today),
              // Era 0 is written at creation with `effectiveFrom = startedOn`;
              // later boundaries are strictly increasing and never future.
              eras: [
                {
                  effectiveFrom: isoDate(startedOn),
                  frequency: frequencies[0]!,
                },
                ...eraBoundaries.map((boundary, index) => ({
                  effectiveFrom: isoDate(boundary),
                  frequency: frequencies[index + 1]!,
                })),
              ],
              entries: entries.map(({ offset, status }) => ({
                localDate: isoDate(offset),
                status,
              })),
              windowDays,
            })),
        )
    })
  })

const buildInput = (caseValue: Case): StreakInput => ({
  startedOn: caseValue.startedOn,
  frequencyHistory: caseValue.eras,
  entries: caseValue.entries,
  today: caseValue.today,
  windowDays: caseValue.windowDays,
})

/** Deterministic reorderings of the entries list (§5.1: order is irrelevant). */
const reorderings = (
  entries: ReadonlyArray<{ localDate: string; status: HabitEntryStatus }>,
  salt: number,
): ReadonlyArray<
  ReadonlyArray<{ localDate: string; status: HabitEntryStatus }>
> => {
  const byStatus = [...entries].sort(
    (a, b) =>
      a.status.localeCompare(b.status) ||
      a.localDate.localeCompare(b.localDate),
  )
  const shift = entries.length > 0 ? salt % entries.length : 0
  const rotated = [...entries.slice(shift), ...entries.slice(0, shift)]
  return [[...entries].reverse(), byStatus, rotated]
}

/**
 * The §5.4 walk, replayed over the result's own periods: a unit change resets
 * the run, a satisfied period extends it, a closed unsatisfied period breaks
 * it, and an unsatisfied open period leaves it alone. `best` is per unit, so
 * a run of one unit survives a frequency change into `best`.
 */
const replayWalk = (
  input: StreakInput,
  result: StreakResult,
): {
  run: number
  since: string | null
  best: { days: number; weeks: number }
} => {
  const eras = input.frequencyHistory
  let run = 0
  let runStart: string | null = null
  let bestDays = 0
  let bestWeeks = 0
  let previousEra = -1
  for (const period of result.periods) {
    // The era in force when the period started; era 0 covers a period that
    // reaches back before `startedOn` (the opening week).
    const at = period.start < input.startedOn ? input.startedOn : period.start
    let eraIndex = 0
    for (let cursor = 1; cursor < eras.length; cursor += 1) {
      if (eras[cursor]!.effectiveFrom <= at) eraIndex = cursor
      else break
    }
    if (
      previousEra >= 0 &&
      eraIndex > previousEra &&
      streakUnitOf(eras[eraIndex]!.frequency) !==
        streakUnitOf(eras[previousEra]!.frequency)
    ) {
      // R10: a unit change closes the run (and files it under `best`).
      run = 0
      runStart = null
    }
    if (period.satisfied) {
      run += 1
      if (runStart === null) runStart = period.start
      if (period.unit === 'day') bestDays = Math.max(bestDays, run)
      else bestWeeks = Math.max(bestWeeks, run)
    } else if (!period.open) {
      // R8: only a closed period can break the streak.
      run = 0
      runStart = null
    }
    previousEra = eraIndex
  }
  return {
    run,
    since:
      run === 0 || runStart === null
        ? null
        : runStart < input.startedOn
          ? input.startedOn
          : runStart,
    best: { days: bestDays, weeks: bestWeeks },
  }
}

describe('habit streak (property laws)', () => {
  it('is invariant under reordering of the entries', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput(caseValue)
        const result = habitStreak(input)
        // The salt only picks a rotation; any deterministic value works.
        const salt = Number(input.today.slice(8, 10))
        for (const entries of reorderings(input.entries, salt)) {
          expect(habitStreak({ ...input, entries })).toEqual(result)
        }
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('treats a log of all-missed days exactly like no log at all', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput(caseValue)
        const allMissed = input.entries.map(entry => ({
          localDate: entry.localDate,
          status: 'missed' as const,
        }))
        // R1/R2: blank is credit 0 and weight 0, and so is missed.
        expect(habitStreak({ ...input, entries: allMissed })).toEqual(
          habitStreak({ ...input, entries: [] }),
        )
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('reports the §5.4 walk over its own periods (best survives unit changes)', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput(caseValue)
        const result = habitStreak(input)
        const replayed = replayWalk(input, result)
        expect(result.current.count).toBe(replayed.run)
        expect(result.current.since).toBe(replayed.since)
        expect(result.best).toEqual(replayed.best)
        const lastPeriod = result.periods[result.periods.length - 1]
        expect(result.current.unit).toBe(
          lastPeriod === undefined
            ? streakUnitOf(input.frequencyHistory[0]!.frequency)
            : lastPeriod.unit,
        )
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('an unsatisfied open period never breaks the streak', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput(caseValue)
        const result = habitStreak(input)
        const open = result.open
        if (open === null || open.satisfied) return
        // R9: blanking every entry inside the unsatisfied open period cannot
        // move the streak, the best or the rate — the open period can only
        // add once satisfied, never subtract while open.
        const blanked = input.entries.filter(
          entry => entry.localDate < open.start || entry.localDate > open.end,
        )
        const blankedResult = habitStreak({ ...input, entries: blanked })
        expect(blankedResult.current).toEqual(result.current)
        expect(blankedResult.best).toEqual(result.best)
        expect(blankedResult.rate).toBe(result.rate)
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('a habit with no entries has no streak, no best and no satisfied period', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput({ ...caseValue, entries: [] })
        const result = habitStreak(input)
        expect(result.current.count).toBe(0)
        expect(result.current.since).toBeNull()
        expect(result.best).toEqual({ days: 0, weeks: 0 })
        expect(result.periods.every(period => !period.satisfied)).toBe(true)
        // The rate is either 0 (a closed expected day already fell inside
        // the window) or null (nothing qualifies yet, R16) — never a credit.
        expect(result.rate === 0 || result.rate === null).toBe(true)
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('a clock behind startedOn yields the exact empty result (§4.3)', () => {
    fc.assert(
      fc.property(arbCase, caseValue => {
        const input = buildInput(caseValue)
        const result = habitStreak({
          ...input,
          today: addLocalDays(input.startedOn, -1),
        })
        expect(result).toEqual({
          current: {
            unit: streakUnitOf(input.frequencyHistory[0]!.frequency),
            count: 0,
            since: null,
          },
          open: null,
          best: { days: 0, weeks: 0 },
          rate: null,
          periods: [],
          unitChanges: [],
        })
      }),
      { seed: SEED, numRuns: 25 },
    )
  })
})
