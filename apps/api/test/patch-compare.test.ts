import { describe, expect, it } from 'vitest'
import { unchangedExcept } from '../src/patch-compare.js'

/**
 * The patch-derived no-op test every `update` path shares. Its contract is
 * what keeps a new patch field from being silently classified as "nothing
 * changed": the patch names the compared fields, so a forgotten field cannot
 * exist.
 *
 * The third argument is used for its *keys* only (the next row already holds
 * the applied value), so the tests pass the value a caller would send.
 */

interface Rule {
  readonly frequency: string
  readonly interval: number
}

interface Row {
  readonly title: string
  readonly due: string | null
  readonly tags: ReadonlyArray<string>
  readonly rule: Rule | null
}

const row = (overrides: Partial<Row> = {}): Row => ({
  title: 'خرید نان',
  due: '2026-10-20',
  tags: ['a', 'b'],
  rule: { frequency: 'daily', interval: 1 },
  ...overrides,
})

describe('unchangedExcept', () => {
  it('compares the primitive patch fields', () => {
    expect(unchangedExcept(row(), row(), { title: 'خرید نان' })).toBe(true)
    expect(
      unchangedExcept(row(), row({ title: 'نان' }), { title: 'نان' }),
    ).toBe(false)
    expect(unchangedExcept({ n: 1 }, { n: 2 }, { n: 2 })).toBe(false)
    expect(unchangedExcept({ n: 1 }, { n: 1 }, { n: 1 })).toBe(true)
    expect(
      unchangedExcept({ flag: true }, { flag: true }, { flag: true }),
    ).toBe(true)
  })

  it('compares arrays element-wise', () => {
    expect(
      unchangedExcept(row(), row({ tags: ['a', 'b'] }), { tags: ['a', 'b'] }),
    ).toBe(true)
    expect(
      unchangedExcept(row(), row({ tags: ['b', 'a'] }), { tags: ['b', 'a'] }),
    ).toBe(false)
    expect(unchangedExcept(row(), row({ tags: ['a'] }), { tags: ['a'] })).toBe(
      false,
    )
  })

  it('compares nested objects key-wise, so key order does not matter', () => {
    expect(
      unchangedExcept(
        { rule: { frequency: 'daily', interval: 1 } },
        { rule: { interval: 1, frequency: 'daily' } },
        { rule: { interval: 1, frequency: 'daily' } },
      ),
    ).toBe(true)
    expect(
      unchangedExcept(
        row(),
        row({ rule: { frequency: 'weekly', interval: 1 } }),
        { rule: { frequency: 'weekly', interval: 1 } },
      ),
    ).toBe(false)
  })

  it('keeps null and undefined distinct', () => {
    expect(
      unchangedExcept(row({ due: null }), row({ due: null }), { due: null }),
    ).toBe(true)
    const nullable: { readonly due: string | null | undefined } = { due: null }
    expect(unchangedExcept(nullable, { due: undefined }, { due: null })).toBe(
      false,
    )
    // An absent key reads as undefined, so `{ interval: undefined }` and a
    // missing `interval` are the same value — but not the same as `null`.
    interface SparseRule {
      readonly frequency: string
      readonly interval?: number | null | undefined
    }
    const before: { readonly rule: SparseRule | undefined } = {
      rule: { frequency: 'daily' },
    }
    expect(
      unchangedExcept(
        before,
        { rule: { frequency: 'daily', interval: undefined } },
        { rule: { frequency: 'daily' } },
      ),
    ).toBe(true)
    expect(
      unchangedExcept(
        before,
        { rule: { frequency: 'daily', interval: null } },
        { rule: { frequency: 'daily' } },
      ),
    ).toBe(false)
    expect(
      unchangedExcept(
        before,
        { rule: undefined },
        {
          rule: { frequency: 'daily' },
        },
      ),
    ).toBe(false)
  })

  it('ignores patch fields the caller omitted', () => {
    // `tags` and `rule` both changed, but the caller only sent `title`.
    expect(
      unchangedExcept(
        row(),
        row({ tags: ['z'], rule: { frequency: 'monthly', interval: 2 } }),
        { title: 'خرید نان' },
      ),
    ).toBe(true)
    expect(unchangedExcept(row(), row({ title: 'نان' }), {})).toBe(true)
  })

  it('compares a patch field the current row does not have', () => {
    interface Colored {
      readonly title: string
      readonly color?: string | null
    }
    const current: Colored = { title: 'a' }
    expect(
      unchangedExcept(
        current,
        { title: 'a', color: '#fff' },
        { color: '#fff' },
      ),
    ).toBe(false)
    expect(
      unchangedExcept(current, { title: 'a', color: null }, { color: null }),
    ).toBe(false)
  })
})
