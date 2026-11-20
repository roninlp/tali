import { describe, expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { DueFireWire, SweepRequest, SweepResponse } from '@tali/reminder-domain'

/**
 * The internal wire, exercised from the Worker side: the schemas the api
 * posts decode into exactly the shapes the tick driver and the model's
 * commands consume, and the tally the model posts back survives the same
 * round trip. The aggregate's behaviour itself is covered by the model
 * package's stories.
 */
describe('the internal wire between the api and this Worker', () => {
  it('decodes one tick payload, fires and facts included', () => {
    const decoded = Schema.decodeUnknownOption(SweepRequest)({
      now: '2026-10-21T05:30:00.000Z',
      fires: [
        {
          ownerId: 'user-a',
          now: '2026-10-21T05:30:00.000Z',
          reminderId: '0197f100-7000-7000-8000-700000000101',
          scheduledFor: '2026-10-21T05:30:00.000Z',
          reminderTimeZone: 'Asia/Tehran',
          ownerTimeZone: 'Asia/Tehran',
          tier: 'critical',
          version: 1,
          repeat: { _tag: 'daily', time: '09:00' },
          silencedUntil: null,
          title: 'داروی فشار',
          note: null,
          kind: 'medication',
        },
      ],
      facts: [
        {
          ownerId: 'user-a',
          dispatchId: '0197f100-7000-7000-8000-700000000201',
          title: 'یادآوری',
          note: null,
          kind: 'general',
          tier: 'normal',
          silencedUntil: null,
          deletedAt: null,
        },
      ],
    })
    expect(decoded._tag).toBe('Some')
    if (decoded._tag !== 'Some') return
    // The claim-time policy's fields all travelled: the model needs nothing
    // but what the tick read.
    const fire = Schema.decodeUnknownOption(DueFireWire)(decoded.value.fires[0])
    expect(fire._tag).toBe('Some')
  })

  it('round-trips the tally the api logs', () => {
    const tally = {
      claimed: 10,
      suppressed: 1,
      due: 10,
      expired: 3,
    }
    const decoded = Schema.decodeUnknownOption(SweepResponse)(tally)
    expect(decoded._tag).toBe('Some')
    if (decoded._tag !== 'Some') return
    expect(decoded.value).toEqual(tally)
  })
})
