import { describe, expect, test } from 'vite-plus/test'

import { overlayRowsById } from './overlay'

/**
 * The keyed overlay rule the Today and Calendar lanes share: pending mirror
 * rows beat server rows, server rows for non-pending ids win, tombstones
 * delete, and the lane's own `merge` callback decides how the fold happens.
 */

interface Row {
  readonly id: string
  readonly title: string
  readonly origin: 'server' | 'mirror'
}

const serverRow = (id: string, title = id): Row => ({
  id,
  title,
  origin: 'server',
})

const mirrorRow = (id: string, title = id): Row => ({
  id,
  title,
  origin: 'mirror',
})

const overlay = (input: {
  readonly base: ReadonlyArray<Row>
  readonly mirror: ReadonlyArray<Row>
  readonly overlayIds: ReadonlyArray<string>
  readonly deletedIds?: ReadonlyArray<string>
}): ReadonlyArray<Row> =>
  overlayRowsById({
    base: input.base,
    mirror: input.mirror,
    overlayIds: new Set(input.overlayIds),
    deletedIds:
      input.deletedIds === undefined ? undefined : new Set(input.deletedIds),
    merge: (_maybeBase, row) => row,
  })

describe('overlayRowsById', () => {
  test('a pending mirror row beats the server row for its id', () => {
    const merged = overlay({
      base: [serverRow('one', 'از سرور')],
      mirror: [mirrorRow('one', 'ویرایش محلی')],
      overlayIds: ['one'],
    })

    expect(merged).toEqual([mirrorRow('one', 'ویرایش محلی')])
  })

  test('server rows for non-pending ids win', () => {
    const merged = overlay({
      base: [serverRow('one')],
      mirror: [mirrorRow('one', 'ویرایش محلی')],
      overlayIds: [],
    })

    expect(merged).toEqual([serverRow('one')])
  })

  test('the server row survives when the mirror lacks the pending id', () => {
    const merged = overlay({
      base: [serverRow('one')],
      mirror: [],
      overlayIds: ['one'],
    })

    expect(merged).toEqual([serverRow('one')])
  })

  test('a mirror row the server has not seen joins the lane', () => {
    const merged = overlay({
      base: [serverRow('one')],
      mirror: [mirrorRow('two')],
      overlayIds: ['two'],
    })

    expect(merged).toEqual([serverRow('one'), mirrorRow('two')])
  })

  test('a tombstoned id drops out of the base rows', () => {
    const merged = overlay({
      base: [serverRow('gone'), serverRow('stays')],
      mirror: [],
      overlayIds: ['gone'],
      deletedIds: ['gone'],
    })

    expect(merged).toEqual([serverRow('stays')])
  })

  test('the merge callback sees the base row it lands on', () => {
    const merged = overlayRowsById({
      base: [{ id: 'one', title: 'از سرور' }],
      mirror: [{ id: 'one', title: 'ویرایش محلی' }],
      overlayIds: new Set(['one']),
      merge: (maybeBase, row) => ({
        id: row.id,
        title: `${maybeBase?.title ?? 'جدید'} + ${row.title}`,
      }),
    })

    expect(merged).toEqual([{ id: 'one', title: 'از سرور + ویرایش محلی' }])
  })
})
