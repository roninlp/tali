import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { decodeErrorEnvelope, entityKey, type EntityRef } from './sync.js'

/**
 * The sync identity and the shared error envelope are the two shapes every
 * layer (API, sync client, web mirror, conflict lab) has to agree on, so they
 * are asserted here once instead of per consumer.
 */

describe('entityKey', () => {
  it('agrees across the ref and the two-argument call style', () => {
    const ref: EntityRef = { entityType: 'task', entityId: 'task-1' }
    expect(entityKey(ref)).toBe(entityKey('task', 'task-1'))
  })

  it('joins with a NUL separator, so type and id cannot run together', () => {
    expect(entityKey('task', 'task-1')).toBe('task\u0000task-1')
    // An empty id still carries the separator: prefixes stay unambiguous.
    expect(entityKey('event', '')).toBe('event\u0000')
    expect(entityKey('task', 'task-1')).not.toBe('tasktask-1')
  })

  it('keeps distinct types and ids distinct', () => {
    const keys = new Set([
      entityKey('task', 'a'),
      entityKey('task', 'b'),
      entityKey('note', 'a'),
    ])
    expect(keys.size).toBe(3)
  })
})

describe('decodeErrorEnvelope', () => {
  const canonical = {
    error: {
      code: 'Forbidden',
      message: 'This row belongs to another household',
      retryable: false,
      details: { entityId: 'task-1' },
    },
  }

  it('accepts the canonical envelope and exposes retryable', () => {
    const decoded = decodeErrorEnvelope(canonical)
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) return
    expect(decoded.value.error.code).toBe('Forbidden')
    expect(decoded.value.error.retryable).toBe(false)
    expect(decoded.value.error.details.entityId).toBe('task-1')
  })

  it('rejects an envelope that omits retryable', () => {
    expect(
      decodeErrorEnvelope({
        error: {
          code: 'Forbidden',
          message: 'This row belongs to another household',
          details: {},
        },
      }),
    ).toEqual(Option.none())
  })

  it('rejects a body that is not an envelope at all', () => {
    expect(decodeErrorEnvelope(undefined)).toEqual(Option.none())
    expect(decodeErrorEnvelope({ error: { code: 'Forbidden' } })).toEqual(
      Option.none(),
    )
  })
})
