import { Option } from 'effect'

import {
  type HabitEntryRow,
  HabitEntryRow as HabitEntryRowSchema,
  HabitFrequency,
  type HabitRow,
} from '../habits-model'
import { mirrorHabit, mirrorSnapshot } from '../mirror-fixtures'
import { DISPLAY, TODAY_NOW } from '../test-fixtures'
import * as Habits from './habits'
import type { Inputs, Model } from './habits'

/**
 * Deterministic Habits fixtures shared by the Story and Scene tests.
 *
 * The fixed instant is 2026-10-30T09:30Z, which is Friday 8 Aban 1405 in
 * Tehran, so the Jalali month and the streak copy stay stable everywhere.
 */

export const HABIT_ID = '0192f0a0-0000-7000-8000-000000000030'
export const SECOND_HABIT_ID = '0192f0a0-0000-7000-8000-000000000031'
export const HABIT_ENTRY_ID = '0192f0a0-0000-7000-8000-000000000032'

export const habitRow = (overrides: Partial<HabitRow> = {}): HabitRow =>
  mirrorHabit({ id: HABIT_ID, ...overrides })

export const weeklyHabit = (overrides: Partial<HabitRow> = {}): HabitRow =>
  habitRow({
    id: SECOND_HABIT_ID,
    title: 'ورزش',
    description: 'هر هفته سه بار',
    icon: '🏃',
    color: '#2e9d57',
    frequency: HabitFrequency.weekly({ times: 3 }),
    frequencyHistory: [
      {
        effectiveFrom: '2026-10-24',
        frequency: HabitFrequency.weekly({ times: 3 }),
      },
    ],
    startedOn: '2026-10-24',
    reminderTime: '07:00',
    createdAt: '2026-10-24T08:00:00.000Z',
    updatedAt: '2026-10-24T08:00:00.000Z',
    ...overrides,
  })

export const habitEntryRow = (
  overrides: Partial<HabitEntryRow> = {},
): HabitEntryRow =>
  HabitEntryRowSchema.make({
    id: HABIT_ENTRY_ID,
    habitId: HABIT_ID,
    localDate: '2026-10-28',
    status: 'done',
    timeZone: 'Asia/Tehran',
    updatedAt: '2026-10-28T08:00:00.000Z',
    version: 1,
    ...overrides,
  })

export const habitsInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  isStoreReady: true,
  isOnline: true,
  pending: 0,
  mirror: mirrorSnapshot(),
  pendingKeys: [],
  maybeSyncError: Option.none(),
  maybeUserId: Option.none(),
  ...overrides,
})

export const habitsModel = (overrides: Partial<Model> = {}): Model => ({
  ...Habits.initialModel(TODAY_NOW),
  ...overrides,
})
