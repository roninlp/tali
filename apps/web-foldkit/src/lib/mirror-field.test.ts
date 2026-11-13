import { Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { MirrorRecord } from '@tali/sync-client'

import {
  asNonEmptyStringOption,
  asOptionalString,
  mirrorCreatedAt,
  mirrorId,
  mirrorMeta,
  mirrorNonEmpty,
  mirrorNullableNonEmpty,
  mirrorNullableString,
  mirrorText,
  mirrorTimeZone,
  mirrorVisibility,
} from './mirror-field'

/**
 * The shared projector rules: absent values, zone resolution, the sync
 * metadata spread, and the per-aggregate visibility fallback. Each projector's
 * own test covers its aggregate fields; this covers the rules they all share.
 */

const record = (
  data: MirrorRecord['data'],
  overrides: Partial<MirrorRecord> = {},
): MirrorRecord => ({
  entityType: 'task',
  entityId: '0192f0a0-0000-7000-8000-000000000001',
  version: 4,
  updatedAt: '2026-10-20T09:40:00.000Z',
  deletedAt: null,
  data,
  ...overrides,
})

describe('mirror field decoders', () => {
  test('an empty string is present, a non-string is not', () => {
    expect(asOptionalString('')).toEqual(Option.some(''))
    expect(asOptionalString(null)).toEqual(Option.none())
    expect(asOptionalString(42)).toEqual(Option.none())
  })

  test('the non-empty decoder treats an empty string as absent', () => {
    expect(asNonEmptyStringOption('x')).toEqual(Option.some('x'))
    expect(asNonEmptyStringOption('')).toEqual(Option.none())
    expect(asNonEmptyStringOption(undefined)).toEqual(Option.none())
  })
})

describe('mirror text fields', () => {
  test('mirrorText falls back to an empty string, or the caller copy', () => {
    expect(mirrorText(record({ title: 'خرید' }), 'title')).toBe('خرید')
    expect(mirrorText(record({}), 'title')).toBe('')
    expect(mirrorText(record({ title: 7 }), 'title', 'بدون نام')).toBe(
      'بدون نام',
    )
  })

  test('mirrorNullableString keeps an empty string, the non-empty form does not', () => {
    expect(
      mirrorNullableString(record({ description: '' }), 'description'),
    ).toBe('')
    expect(
      mirrorNullableNonEmpty(record({ description: '' }), 'description'),
    ).toBeNull()
    expect(mirrorNullableString(record({}), 'description')).toBeNull()
  })

  test('mirrorNonEmpty keeps the value when it has one', () => {
    expect(mirrorNonEmpty(record({ name: 'نان' }), 'name', '')).toBe('نان')
    expect(mirrorNonEmpty(record({ name: '' }), 'name', 'بی‌نام')).toBe('بی‌نام')
  })

  test('mirrorId reads the mirror identity', () => {
    expect(mirrorId(record({}))).toBe('0192f0a0-0000-7000-8000-000000000001')
  })
})

describe('mirror zone and timestamps', () => {
  test('a stored zone is accepted, an unknown one resolves to the default', () => {
    expect(mirrorTimeZone(record({ timeZone: 'UTC' }))).toBe('UTC')
    expect(mirrorTimeZone(record({ timeZone: 'Mars/Olympus' }))).toBe(
      'Asia/Tehran',
    )
    expect(mirrorTimeZone(record({}))).toBe('Asia/Tehran')
    expect(mirrorTimeZone(record({}), 'UTC')).toBe('UTC')
  })

  test('createdAt falls back to the row updatedAt', () => {
    expect(
      mirrorCreatedAt(record({ createdAt: '2026-10-01T08:00:00.000Z' })),
    ).toBe('2026-10-01T08:00:00.000Z')
    expect(mirrorCreatedAt(record({}))).toBe('2026-10-20T09:40:00.000Z')
  })
})

describe('mirror sync metadata', () => {
  test('reports the row version and whether its last push was rejected', () => {
    expect(mirrorMeta(record({}))).toEqual({
      updatedAt: '2026-10-20T09:40:00.000Z',
      version: 4,
      hasSyncError: false,
    })
    expect(
      mirrorMeta(
        record(
          {},
          {
            syncError: {
              code: 'Conflict',
              message: 'نسخه قدیمی',
              at: '2026-10-20T09:41:00.000Z',
              clientMutationId: 'm1',
            },
          },
        ),
      ).hasSyncError,
    ).toBe(true)
  })
})

describe('mirror visibility', () => {
  test('an explicit value wins for every aggregate', () => {
    expect(mirrorVisibility(record({ visibility: 'private' }), 'task')).toBe(
      'private',
    )
    expect(mirrorVisibility(record({ visibility: 'shared' }), 'note')).toBe(
      'shared',
    )
  })

  test('an absent or unknown value falls back to the aggregate policy', () => {
    expect(mirrorVisibility(record({}), 'task')).toBe('shared')
    expect(mirrorVisibility(record({}), 'list')).toBe('shared')
    expect(mirrorVisibility(record({}), 'listItem')).toBe('shared')
    expect(mirrorVisibility(record({}), 'note')).toBe('private')
    expect(mirrorVisibility(record({}), 'habit')).toBe('private')
    expect(mirrorVisibility(record({}), 'occasion')).toBe('private')
    expect(mirrorVisibility(record({ visibility: 'public' }), 'task')).toBe(
      'shared',
    )
  })
})
