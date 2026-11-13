import { describe, expect, it } from 'vite-plus/test'
import { EventId, HabitId, OccasionId, TaskId } from './common.js'
import { uuidV7 } from '../ids.js'
import {
  decodeReminderLink,
  encodeReminderLink,
  eventReminderLink,
  habitReminderLink,
  noReminderLink,
  occasionReminderLink,
  type ReminderLink,
  taskReminderLink,
} from './reminder-link.js'

/**
 * The `ReminderLink` ↔ `(link_type, link_id)` codec (ticket #60).
 *
 * Every SQL path flattens and rebuilds the union through these two functions,
 * so the round trip and the malformed-row fallback are the contract: a stored
 * row must read back as the same variant, and anything unrepresentable must
 * read as `none` rather than throw.
 */

const HABIT_ID = uuidV7(1_700_000_000_100)
const TASK_ID = uuidV7(1_700_000_000_101)
const EVENT_ID = uuidV7(1_700_000_000_102)
const OCCASION_ID = uuidV7(1_700_000_000_103)

const VARIANTS: ReadonlyArray<ReminderLink> = [
  noReminderLink(),
  habitReminderLink(HabitId.make(HABIT_ID)),
  taskReminderLink(TaskId.make(TASK_ID)),
  eventReminderLink(EventId.make(EVENT_ID)),
  occasionReminderLink(OccasionId.make(OCCASION_ID)),
]

describe('encodeReminderLink', () => {
  it('flattens each variant to its type and id', () => {
    expect(encodeReminderLink(noReminderLink())).toEqual({
      linkType: 'none',
      linkId: null,
    })
    expect(
      encodeReminderLink(habitReminderLink(HabitId.make(HABIT_ID))),
    ).toEqual({ linkType: 'habit', linkId: HABIT_ID })
    expect(encodeReminderLink(taskReminderLink(TaskId.make(TASK_ID)))).toEqual({
      linkType: 'task',
      linkId: TASK_ID,
    })
    expect(
      encodeReminderLink(eventReminderLink(EventId.make(EVENT_ID))),
    ).toEqual({ linkType: 'event', linkId: EVENT_ID })
    expect(
      encodeReminderLink(occasionReminderLink(OccasionId.make(OCCASION_ID))),
    ).toEqual({ linkType: 'occasion', linkId: OCCASION_ID })
  })
})

describe('decodeReminderLink', () => {
  it('round-trips every variant through encode', () => {
    for (const link of VARIANTS) {
      const columns = encodeReminderLink(link)
      expect(decodeReminderLink(columns.linkType, columns.linkId)).toEqual(link)
    }
  })

  it('reads an unknown type as none', () => {
    expect(decodeReminderLink('project', TASK_ID)).toEqual(noReminderLink())
    expect(decodeReminderLink('', TASK_ID)).toEqual(noReminderLink())
    expect(decodeReminderLink('TASK', TASK_ID)).toEqual(noReminderLink())
  })

  it('reads a known type with a null id as none', () => {
    for (const linkType of ['habit', 'task', 'event', 'occasion']) {
      expect(decodeReminderLink(linkType, null)).toEqual(noReminderLink())
    }
  })
})
