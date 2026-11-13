import 'fake-indexeddb/auto'
import { Option } from 'effect'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import type { Event } from '@tali/domain'
import {
  LocalDate,
  TimestampUtc,
  allDayEventTiming,
  timedEventTiming,
  untilRecurrenceEnd,
  uuidV7,
} from '@tali/domain'
import { openLocalStore } from '@tali/sync-client'
import type { LocalStore } from '@tali/sync-client'

import { CalendarRecurrenceEnd, CalendarTiming } from './calendar-data'
import type { CalendarEventSource } from './calendar-data'
import {
  EVENT_MISSING_COPY,
  SPLIT_REQUIRES_SERVER,
  applyEventScopeInMirror,
  createEventInMirror,
  deleteEventWithinScope,
  editEventWithinScope,
  eventFromMirror,
  eventRowsFromMirror,
  eventScopeUsesServer,
  overlayEventSources,
  timingOfDraft,
  toEventRow,
} from './event-writes'
import { EventRow } from './event-writes'

/**
 * The calendar's client event adapter and edit-scope seam, ported from
 * `apps/web/src/lib/events/model.test.ts` and `.../scope.test.ts`.
 */

const NOW = '2026-10-30T09:30:00.000Z'
const USER = uuidV7()
const HOUSEHOLD = uuidV7()

const eventRow = (overrides: Partial<EventRow> = {}): EventRow =>
  EventRow.make({
    id: '0192f0a0-0000-7000-8000-000000000040',
    title: 'جلسهٔ هفتگی',
    description: null,
    location: null,
    category: null,
    color: null,
    people: [],
    timing: CalendarTiming.allDay({ date: '2026-10-23' }),
    timeZone: 'Asia/Tehran',
    recurrence: null,
    exceptions: [],
    occasionId: null,
    ownerId: USER,
    householdId: HOUSEHOLD,
    visibility: 'shared',
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    deletedAt: null,
    hasSyncError: false,
    ...overrides,
  })

const weeklyRow = (overrides: Partial<EventRow> = {}): EventRow =>
  eventRow({
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      byDay: [5],
      end: CalendarRecurrenceEnd.never(),
    },
    ...overrides,
  })

const eventOf = (row: EventRow): Event => {
  const event = eventFromMirror(row, { userId: USER, householdId: HOUSEHOLD })

  if (event === null) {
    throw new Error('fixture event did not hydrate')
  }

  return event
}

const source = (
  input: Partial<CalendarEventSource> & { readonly id: string },
): CalendarEventSource => ({
  title: input.title ?? input.id,
  description: null,
  location: null,
  category: null,
  color: null,
  people: [],
  timing: input.timing ?? CalendarTiming.allDay({ date: '2026-10-23' }),
  timeZone: input.timeZone ?? 'UTC',
  recurrence: input.recurrence ?? null,
  exceptions: input.exceptions ?? [],
  id: input.id,
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

describe('event row projection', () => {
  it('reads a locally written row', () => {
    const row = toEventRow({
      entityType: 'event',
      entityId: '0192f0a0-0000-7000-8000-000000000040',
      version: 1,
      updatedAt: NOW,
      deletedAt: null,
      data: {
        title: 'سفر',
        people: ['علی'],
        timing: CalendarTiming.allDay({ date: '2026-10-22' }),
        timeZone: 'Asia/Tehran',
        exceptions: [],
      },
    })

    expect(row.title).toBe('سفر')
    expect(row.people).toEqual(['علی'])
    expect(row.timing).toEqual(CalendarTiming.allDay({ date: '2026-10-22' }))
    expect(row.timeZone).toBe('Asia/Tehran')
    expect(row.recurrence).toBeNull()
  })

  it('tolerates JSON text columns and malformed timings', () => {
    const row = toEventRow({
      entityType: 'event',
      entityId: '0192f0a0-0000-7000-8000-000000000040',
      version: 1,
      updatedAt: NOW,
      deletedAt: null,
      data: {
        title: 'متن',
        people: '["سارا"]',
        timing:
          '{"_tag":"timed","start":"2026-10-22T09:00:00Z","end":"2026-10-22T10:00:00Z"}',
        recurrence:
          '{"frequency":"weekly","interval":1,"end":{"_tag":"never"}}',
        exceptions: '[]',
      },
    })

    expect(row.people).toEqual(['سارا'])
    expect(row.timing._tag).toBe('timed')
    expect(row.recurrence?.frequency).toBe('weekly')

    const broken = toEventRow({
      entityType: 'event',
      entityId: '0192f0a0-0000-7000-8000-000000000041',
      version: 1,
      updatedAt: '2026-04-01T00:00:00.000Z',
      deletedAt: null,
      data: { timing: '{not json' },
    })

    expect(broken.timing).toEqual(CalendarTiming.allDay({ date: '2026-04-01' }))
  })

  it('hydrates the aggregate with the session fallbacks', () => {
    const event = eventOf(eventRow({ ownerId: null, householdId: null }))

    expect(event.title).toBe('جلسهٔ هفتگی')
    expect(event.ownerId).toBe(USER)
    expect(event.householdId).toBe(HOUSEHOLD)
    expect(event.recurrence).toBeNull()
  })

  it('maps a list of mirror rows', () => {
    expect(eventRowsFromMirror([])).toEqual([])
  })
})

describe('event overlay', () => {
  it('merges only the pending ids over the server rows', () => {
    const server = source({ id: 'one', title: 'از سرور' })

    const pending = eventRow({
      id: 'one',
      title: 'ویرایش محلی',
    })

    const other = eventRow({ id: 'two', title: 'نوشتهٔ دیگر' })

    const merged = overlayEventSources({
      base: [server],
      mirror: [pending, other],
      overlayIds: new Set(['one']),
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('ویرایش محلی')
    expect(merged[0]!.timing).toEqual(server.timing)
  })

  it('drops a locally deleted series from the server snapshot', () => {
    const merged = overlayEventSources({
      base: [source({ id: 'gone' }), source({ id: 'stays' })],
      mirror: [],
      overlayIds: new Set(['gone']),
      deletedIds: new Set(['gone']),
    })

    expect(merged.map(event => event.id)).toEqual(['stays'])
  })

  it('adds a locally created event the server has not seen', () => {
    const created = eventRow({ id: 'new', title: 'تازه' })

    const merged = overlayEventSources({
      base: [],
      mirror: [created],
      overlayIds: new Set(['new']),
    })

    expect(merged.map(event => event.title)).toEqual(['تازه'])
  })
})

describe('draft timing', () => {
  it('keeps an all-day draft on its local date', () => {
    expect(
      timingOfDraft({
        title: 'سفر',
        date: '2026-10-22',
        allDay: true,
        startTime: '09:00',
        endTime: '10:00',
        timeZone: 'Asia/Tehran',
      }),
    ).toEqual(allDayEventTiming(LocalDate.make('2026-10-22')))
  })

  it("turns a wall time in the event's zone into instants", () => {
    expect(
      timingOfDraft({
        title: 'جلسه',
        date: '2026-03-22',
        allDay: false,
        startTime: '09:00',
        endTime: '10:30',
        timeZone: 'Asia/Tehran',
      }),
    ).toEqual(
      timedEventTiming(
        TimestampUtc.make('2026-03-22T05:30:00.000Z'),
        TimestampUtc.make('2026-03-22T07:00:00.000Z'),
      ),
    )
  })

  it('floors a backwards range at one hour', () => {
    expect(
      timingOfDraft({
        title: 'جلسه',
        date: '2026-03-22',
        allDay: false,
        startTime: '10:00',
        endTime: '09:00',
        timeZone: 'UTC',
      }),
    ).toEqual(
      timedEventTiming(
        TimestampUtc.make('2026-03-22T10:00:00.000Z'),
        TimestampUtc.make('2026-03-22T11:00:00.000Z'),
      ),
    )
  })
})

describe('event local writes', () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await openLocalStore(uuidV7())
  })

  it('creates an event row and queues it in one write', async () => {
    const id = uuidV7()

    await createEventInMirror(
      store,
      {
        title: '  مهمانی  ',
        date: '2026-10-30',
        allDay: true,
        startTime: '09:00',
        endTime: '10:00',
        timeZone: 'Asia/Tehran',
      },
      id,
      NOW,
    )

    const row = await store.get('event', id)
    expect(row?.data.title).toBe('مهمانی')
    expect(row?.data.timing).toEqual(
      CalendarTiming.allDay({ date: '2026-10-30' }),
    )
    expect(await store.pending()).toHaveLength(1)
    store.close()
  })

  it('refuses an empty title', async () => {
    await expect(
      createEventInMirror(
        store,
        {
          title: '   ',
          date: '2026-10-30',
          allDay: true,
          startTime: '09:00',
          endTime: '10:00',
          timeZone: 'Asia/Tehran',
        },
        uuidV7(),
        NOW,
      ),
    ).rejects.toThrow('an event needs a title')
    store.close()
  })
})

describe('edit scope — this occurrence', () => {
  it('adds one override exception and leaves the rule alone', () => {
    const row = weeklyRow()

    const change = editEventWithinScope({
      event: eventOf(row),
      instanceId: '2026-10-30',
      overrides: { title: 'جلسهٔ ویژه' },
      scope: 'thisOccurrence',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(change.following).toBeNull()
    expect(change.series.id).toBe(row.id)
    expect(change.series.recurrence).not.toBeNull()
    expect(change.series.exceptions).toHaveLength(1)
    expect(change.series.exceptions[0]).toMatchObject({
      instanceId: '2026-10-30',
      action: 'override',
      overrides: { title: 'جلسهٔ ویژه' },
    })
  })

  it('moves only the chosen occurrence timing', () => {
    const change = editEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-30',
      overrides: {
        timing: allDayEventTiming(LocalDate.make('2026-10-31')),
      },
      scope: 'thisOccurrence',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(change.series.timing).toEqual(
      allDayEventTiming(LocalDate.make('2026-10-23')),
    )
    expect(change.series.exceptions[0]!.overrides).toEqual({
      timing: allDayEventTiming(LocalDate.make('2026-10-31')),
    })
  })

  it('deletes one occurrence without touching the schedule', () => {
    const change = deleteEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-30',
      scope: 'thisOccurrence',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(change.following).toBeNull()
    expect(change.series.deletedAt).toBeNull()
    expect(change.series.exceptions[0]).toMatchObject({
      instanceId: '2026-10-30',
      action: 'delete',
    })
  })
})

describe('edit scope — this and following', () => {
  it('splits the series and keeps the rule in phase', () => {
    const followingId = uuidV7()

    const change = editEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-30',
      overrides: { title: 'جلسهٔ تازه' },
      scope: 'thisAndFollowing',
      exceptionId: uuidV7(),
      followingId,
      now: NOW,
    })

    expect(change.following).not.toBeNull()
    expect(change.following!.id).toBe(followingId)
    expect(change.following!.title).toBe('جلسهٔ تازه')
    expect(change.series.recurrence).toEqual({
      frequency: 'weekly',
      interval: 1,
      byDay: [5],
      end: untilRecurrenceEnd(LocalDate.make('2026-10-29')),
    })
    expect(change.following!.timing).toEqual(
      allDayEventTiming(LocalDate.make('2026-10-30')),
    )
  })

  it('degrades to a whole-series edit at the first occurrence', () => {
    const change = editEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-23',
      overrides: { title: 'از ابتدا' },
      scope: 'thisAndFollowing',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(change.following).toBeNull()
    expect(change.series.title).toBe('از ابتدا')
  })

  it('deletes this and following, tombstoning a series cut at its start', () => {
    const atStart = deleteEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-23',
      scope: 'thisAndFollowing',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(atStart.series.deletedAt).not.toBeNull()

    const later = deleteEventWithinScope({
      event: eventOf(weeklyRow()),
      instanceId: '2026-10-30',
      scope: 'thisAndFollowing',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(later.series.deletedAt).toBeNull()
    expect(later.series.recurrence!.end).toEqual(
      untilRecurrenceEnd(LocalDate.make('2026-10-29')),
    )
  })

  it('edits a one-off event as a plain series edit', () => {
    const row = eventRow({
      timing: CalendarTiming.allDay({ date: '2026-10-30' }),
    })

    const change = editEventWithinScope({
      event: eventOf(row),
      instanceId: '2026-10-30',
      overrides: { title: 'تک‌باره' },
      scope: 'thisAndFollowing',
      exceptionId: uuidV7(),
      followingId: uuidV7(),
      now: NOW,
    })

    expect(change.following).toBeNull()
    expect(change.series.title).toBe('تک‌باره')
    expect(change.series.recurrence).toBeNull()
  })

  it('refuses an instance that is not an occurrence of the series', () => {
    expect(() =>
      editEventWithinScope({
        event: eventOf(weeklyRow()),
        instanceId: '2026-10-29',
        overrides: { title: 'نامعتبر' },
        scope: 'thisOccurrence',
        exceptionId: uuidV7(),
        followingId: uuidV7(),
        now: NOW,
      }),
    ).toThrow(/مجموعه نیست/)
  })
})

describe('scope transport choice', () => {
  it('keeps a one-off event local even while online', () => {
    expect(
      eventScopeUsesServer({
        event: eventOf(eventRow()),
        action: 'edit',
        scope: 'thisOccurrence',
        isOnline: true,
        hasPending: false,
      }),
    ).toBe(false)
  })

  it('sends a connected, clean series split through the service', () => {
    expect(
      eventScopeUsesServer({
        event: eventOf(weeklyRow()),
        action: 'edit',
        scope: 'thisAndFollowing',
        isOnline: true,
        hasPending: false,
      }),
    ).toBe(true)
  })

  it('refuses a split edit offline rather than queueing two rows', () => {
    expect(() =>
      eventScopeUsesServer({
        event: eventOf(weeklyRow()),
        action: 'edit',
        scope: 'thisAndFollowing',
        isOnline: false,
        hasPending: false,
      }),
    ).toThrow(SPLIT_REQUIRES_SERVER)
  })

  it('keeps a series with an unsent mutation on the local path', () => {
    expect(
      eventScopeUsesServer({
        event: eventOf(weeklyRow()),
        action: 'delete',
        scope: 'thisAndFollowing',
        isOnline: true,
        hasPending: true,
      }),
    ).toBe(false)
  })
})

describe('mirror scope commits', () => {
  it('writes one local row and queues it', async () => {
    await withStore(async store => {
      const row = weeklyRow()

      const change = editEventWithinScope({
        event: eventOf(row),
        instanceId: '2026-10-30',
        overrides: { title: 'محلی' },
        scope: 'thisOccurrence',
        exceptionId: uuidV7(),
        followingId: uuidV7(),
        now: NOW,
      })

      await applyEventScopeInMirror(store, change, NOW)

      const stored = await store.get('event', row.id)
      expect(stored?.data.exceptions).toHaveLength(1)
      expect(await store.pending()).toHaveLength(1)
    })
  })

  it("refuses to queue a split, which needs the service's gated batch", async () => {
    await withStore(async store => {
      const row = weeklyRow()

      const change = editEventWithinScope({
        event: eventOf(row),
        instanceId: '2026-10-30',
        overrides: { title: 'نیمهٔ دوم' },
        scope: 'thisAndFollowing',
        exceptionId: uuidV7(),
        followingId: uuidV7(),
        now: NOW,
      })

      await expect(applyEventScopeInMirror(store, change, NOW)).rejects.toThrow(
        SPLIT_REQUIRES_SERVER,
      )
      expect(await store.pending()).toHaveLength(0)
      expect(await store.get('event', row.id)).toBeUndefined()
    })
  })

  it('uses the missing-event copy for an unreadable row', () => {
    expect(EVENT_MISSING_COPY).toContain('حافظهٔ محلی')
    expect(Option.isNone(Option.fromNullishOr(null))).toBe(true)
  })
})
