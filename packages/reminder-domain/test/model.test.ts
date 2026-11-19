import { describe, expect, it } from 'vite-plus/test'
import * as Domain from '@alchemy.run/domain'
import { Reminders } from '../src/Reminders.model.js'

/**
 * One unit test covers the whole declaration: `Domain.verify` finds every
 * hosting-time mistake — a policy that waits for an event no source emits, a
 * projection without a route, a view with state and no initial — without
 * hosting anything.
 */
describe('the Reminders model', () => {
  it('is well defined', () => {
    expect(Domain.verify(Reminders)).toEqual([])
  })
})
