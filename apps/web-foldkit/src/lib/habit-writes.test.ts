import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vite-plus/test'

import { uuidV7 } from '@tali/domain'
import type { LocalStore } from '@tali/sync-client'
import { openLocalStore } from '@tali/sync-client'

import { HabitFrequency } from '../habits-model'
import { createHabitInMirror, updateHabitInMirror } from './habit-writes'

/**
 * Habit mirror writes: an edit that changes no field must leave the row and
 * its outbox entry untouched, exactly like the list/task/occasion builders.
 */

const NOW = '2026-10-20T09:00:00.000Z'
const LATER = '2026-10-20T09:30:00.000Z'
const TZ = 'Asia/Tehran'

const open = (): Promise<LocalStore> => openLocalStore(`user-${uuidV7()}`)

const seedHabit = async (store: LocalStore) => {
  const frequency = HabitFrequency.daily()

  const id = await createHabitInMirror(
    store,
    { title: 'ورزش', frequency, timeZone: TZ },
    uuidV7(),
    NOW,
  )

  return {
    id,
    timeZone: TZ,
    frequency,
    frequencyHistory: [{ effectiveFrom: '2026-10-20', frequency }],
  }
}

describe('habit mirror writes', () => {
  test('an empty patch writes nothing and queues no outbox entry', async () => {
    const store = await open()
    const habit = await seedHabit(store)
    const before = await store.get('habit', habit.id)
    const pendingBefore = await store.pending()

    await updateHabitInMirror(store, habit, {}, LATER)

    expect(await store.get('habit', habit.id)).toEqual(before)
    expect(await store.pending()).toEqual(pendingBefore)
    store.close()
  })

  test('re-submitting the stored frequency is a no-op', async () => {
    const store = await open()
    const habit = await seedHabit(store)
    const before = await store.get('habit', habit.id)
    const pendingBefore = await store.pending()

    await updateHabitInMirror(
      store,
      habit,
      { frequency: habit.frequency },
      LATER,
    )

    expect(await store.get('habit', habit.id)).toEqual(before)
    expect(await store.pending()).toEqual(pendingBefore)
    store.close()
  })
})
