import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { uuidV7 } from '@tali/domain'
import { openLocalStore } from '@tali/sync-client'
import type { LocalStore } from '@tali/sync-client'

import {
  advanceLabel,
  asOccasionSource,
  createOccasionInMirror,
  deleteOccasionInMirror,
  formatAdvanceReminder,
  formatOccasionDate,
  monthOccasionsFromSources,
  occasionsByDate,
  prepareOccasionTaskInMirror,
  toOccasionRow,
  upcomingOccasions,
  updateOccasionInMirror,
} from './occasion-writes'
import { OccasionRow } from './occasion-writes'

/**
 * The calendar's occasion panel seam, ported from
 * `apps/web/src/lib/occasions/model.test.ts`.
 */

const TZ = 'Asia/Tehran'
const TODAY = '2026-10-21'

const row = (overrides: Partial<OccasionRow> = {}): OccasionRow =>
  OccasionRow.make({
    id: '0192f0a0-0000-7000-8000-000000000042',
    title: 'تولد مامان',
    originDate: '1990-04-01',
    timeZone: TZ,
    yearly: true,
    advanceReminderDays: 7,
    preparationTaskId: null,
    color: null,
    visibility: 'shared',
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-01T08:00:00.000Z',
    version: 1,
    hasSyncError: false,
    ...overrides,
  })

const withStore = async (
  run: (store: LocalStore) => Promise<void>,
): Promise<void> => {
  const store = await openLocalStore(uuidV7())

  try {
    await run(store)
  } finally {
    store.close()
  }
}

describe('occasions client model', () => {
  it('projects a mirrored occasion and formats both calendars', async () => {
    await withStore(async store => {
      await createOccasionInMirror(
        store,
        {
          title: 'تولد مامان',
          originDate: '1990-04-01',
          timeZone: TZ,
          yearly: true,
          advanceReminderDays: 7,
        },
        uuidV7(),
        '2026-10-21T10:00:00.000Z',
      )

      const rows = (await store.list('occasion')).map(toOccasionRow)
      const occurrences = monthOccasionsFromSources(
        rows.map(asOccasionSource),
        '2026-04-01',
        '2026-04-30',
      )

      expect(occurrences).toHaveLength(1)
      expect(occurrences[0]?.jalali).toEqual({ year: 1405, month: 1, day: 12 })
      expect(formatOccasionDate(occurrences[0]!, 'persian')).toBe(
        '۱۲ فروردین ۱۴۰۵ · ۱ آوریل ۲۰۲۶',
      )
    })
  })

  it('orders the panel by the next occurrence and formats the reminder', () => {
    const occurrences = monthOccasionsFromSources(
      [
        asOccasionSource(row()),
        asOccasionSource(
          row({
            id: '0192f0a0-0000-7000-8000-000000000043',
            title: 'سالگرد',
            originDate: '2000-05-02',
          }),
        ),
      ],
      '2027-01-01',
      '2027-12-31',
    )

    expect(occurrences).toHaveLength(2)
    const upcoming = upcomingOccasions([row()], TODAY)
    expect(upcoming[0]?.occurrence?.date).toBe('2027-04-01')
    expect(upcoming[0]?.occurrence?.advanceReminderDate).toBe('2027-03-25')
    expect(formatAdvanceReminder(upcoming[0]!.occurrence!, 'persian')).toBe(
      '۷ روز قبل — ۵ فروردین ۱۴۰۶',
    )
    expect(advanceLabel(7)).toBe('یادآوری ۷ روز قبل')
    expect(advanceLabel(null)).toBe('بدون یادآوری پیش از موعد')
    expect(occasionsByDate(occurrences).size).toBe(2)
  })

  it('creates, edits and deletes an occasion in the mirror', async () => {
    await withStore(async store => {
      const id = await createOccasionInMirror(
        store,
        {
          title: '  تولد سارا ',
          originDate: TODAY,
          timeZone: TZ,
          yearly: true,
          advanceReminderDays: 7,
        },
        uuidV7(),
        '2026-10-21T10:00:00.000Z',
      )

      const created = await store.get('occasion', id)
      expect(created?.data.title).toBe('تولد سارا')
      expect(created?.data.advanceReminderDays).toBe(7)

      await updateOccasionInMirror(
        store,
        id,
        { title: 'تولد سارا کوچک', yearly: false, advanceReminderDays: null },
        '2026-10-21T11:00:00.000Z',
      )

      const updated = await store.get('occasion', id)
      expect(updated?.data.title).toBe('تولد سارا کوچک')
      expect(updated?.data.yearly).toBe(false)
      expect(updated?.data.advanceReminderDays).toBeNull()

      await deleteOccasionInMirror(store, id, '2026-10-21T12:00:00.000Z')
      expect(await store.list('occasion')).toHaveLength(0)
      expect(await store.listTrashed('occasion')).toHaveLength(1)
    })
  })

  it('creates the preparation task once and links it', async () => {
    await withStore(async store => {
      await createOccasionInMirror(
        store,
        {
          title: 'تولد سارا',
          originDate: TODAY,
          timeZone: TZ,
          yearly: true,
          advanceReminderDays: 7,
        },
        uuidV7(),
        '2026-10-21T10:00:00.000Z',
      )
      const [occasion] = (await store.list('occasion')).map(toOccasionRow)

      const first = await prepareOccasionTaskInMirror(
        store,
        occasion!,
        TODAY,
        uuidV7(),
        '2026-10-21T10:00:00.000Z',
      )
      expect(first.created).toBe(true)

      const task = await store.get('task', first.taskId)
      expect(task?.data.title).toBe('آماده‌سازی برای تولد سارا')
      expect(task?.data.dueDate).toBe('2026-10-14')
      expect(
        (await store.get('occasion', occasion!.id))?.data.preparationTaskId,
      ).toBe(first.taskId)

      const [linked] = (await store.list('occasion')).map(toOccasionRow)
      const again = await prepareOccasionTaskInMirror(
        store,
        linked!,
        TODAY,
        uuidV7(),
        '2026-10-21T10:01:00.000Z',
      )
      expect(again).toEqual({ taskId: first.taskId, created: false })
      expect(await store.list('task')).toHaveLength(1)
    })
  })

  it('repairs a stale link left by an interrupted task write', async () => {
    await withStore(async store => {
      await createOccasionInMirror(
        store,
        {
          title: 'تولد سارا',
          originDate: TODAY,
          timeZone: TZ,
          yearly: true,
          advanceReminderDays: 7,
        },
        uuidV7(),
        '2026-10-21T10:00:00.000Z',
      )
      const [occasion] = (await store.list('occasion')).map(toOccasionRow)

      await store.writeLocal({
        entityType: 'occasion',
        entityId: occasion!.id,
        op: 'upsert',
        patch: { preparationTaskId: uuidV7() },
        now: '2026-10-21T10:00:00.000Z',
      })

      const [stale] = (await store.list('occasion')).map(toOccasionRow)
      const repaired = await prepareOccasionTaskInMirror(
        store,
        stale!,
        TODAY,
        uuidV7(),
        '2026-10-21T10:02:00.000Z',
      )
      expect(repaired.created).toBe(true)
      expect(await store.get('task', repaired.taskId)).toBeDefined()
      expect(
        (await store.get('occasion', occasion!.id))?.data.preparationTaskId,
      ).toBe(repaired.taskId)
      expect(await store.list('task')).toHaveLength(1)
    })
  })

  it('refuses a passed one-off occasion with no next date', async () => {
    await withStore(async store => {
      const past = row({ yearly: false, originDate: '2020-04-01' })

      await expect(
        prepareOccasionTaskInMirror(
          store,
          past,
          TODAY,
          uuidV7(),
          '2026-10-21T10:00:00.000Z',
        ),
      ).rejects.toThrow('this occasion has no upcoming occurrence')
    })
  })
})
