import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'
import { SEED } from './property-helpers.js'
import { buildVariantInsensitivePattern, normalizePersian } from './persian.js'

/**
 * Ticket #118 — property laws for the Persian normalization and the
 * variant-insensitive matcher.
 *
 * The laws pin the two documented contracts of `persian.ts`: the fold is
 * idempotent (the write path and the query path can both call it), and a
 * folded match finds every spelling of the original text's folding class
 * (a note written in one spelling is found by the other).
 */

/** Inclusive code-point range as single-character strings. */
const range = (lo: number, hi: number): ReadonlyArray<string> =>
  Array.from({ length: hi - lo + 1 }, (_, index) =>
    String.fromCodePoint(lo + index),
  )

/**
 * The alphabet the laws draw from: the Arabic block (base letters, hamza
 * carriers, harakat), the Farsi-specific letters, the Quranic marks, both
 * Arabic-Indic digit sets, the zero-width joiners, real spaces, ASCII
 * (including the RegExp metacharacters), and the Arabic presentation forms
 * that only NFKC folds.
 */
const ALPHABET = [
  ...range(0x0620, 0x065f),
  '\u0670',
  '\u0679',
  '\u067e',
  '\u0686',
  '\u06a9',
  '\u06af',
  '\u06cc',
  ...range(0x06d6, 0x06ed),
  ...range(0x0660, 0x0669),
  ...range(0x06f0, 0x06f9),
  '\u200c',
  '\u200d',
  ' ',
  '\t',
  '\u00a0',
  ...'aBz09.,(*")-:?!_/',
  ...range(0xfb50, 0xfbff),
  ...range(0xfe70, 0xfeff),
]

const arbAlphabetText = fc
  .array(fc.constantFrom(...ALPHABET), { maxLength: 24 })
  .map(chars => chars.join(''))

// The idempotence law additionally takes arbitrary Unicode text: the write
// and query paths receive user text, not a curated alphabet.
const arbText = fc.oneof(
  arbAlphabetText,
  fc.string({ unit: 'binary', maxLength: 16 }),
)

/**
 * The folding classes of `VARIANT_CLASSES` spelled out (the module keeps its
 * own table private): canonical character → alternative spelling.
 */
const VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['\u06cc', '\u064a'], // yeh
  ['\u06cc', '\u0649'], // alef maksura
  ['\u06a9', '\u0643'], // kaf
  ['\u0647', '\u0629'], // teh marbuta
  ['\u0627', '\u0623'], // alef hamza above
  ['\u0627', '\u0625'], // alef hamza below
  ['\u0627', '\u0622'], // alef madda
  ['\u0648', '\u0624'], // waw hamza
]

/** Alternative spellings of a canonical character, if it has any. */
const variantsOf = (char: string): ReadonlyArray<string> =>
  VARIANTS.filter(([canonical]) => canonical === char).map(
    ([, alternative]) => alternative,
  )

const hasSearchableChar = (text: string): boolean =>
  [...text].some(char => /[\p{L}\p{N}]/u.test(char))

/**
 * Respell `normalized` inside its folding class and drop at most one
 * half-space or space between each pair of characters — the text variations
 * the pattern is documented to match.
 */
const unfold = (
  normalized: string,
  substitutions: ReadonlyArray<boolean>,
  separators: ReadonlyArray<string>,
): string => {
  const chars = [...normalized]
  const out: Array<string> = []
  chars.forEach((char, index) => {
    if (index > 0) out.push(separators[index] ?? '')
    const variants = substitutions[index] === true ? variantsOf(char) : []
    out.push(variants.length > 0 ? variants[index % variants.length]! : char)
  })
  return out.join('')
}

/** A query plus a respelled variant of its normalized form. */
const arbFoldingCase = arbAlphabetText.chain(query => {
  const normalized = normalizePersian(query)
  const length = [...normalized].length
  return fc
    .record({
      substitutions: fc.array(fc.boolean(), {
        minLength: length,
        maxLength: length,
      }),
      separator: fc.array(fc.constantFrom('', ' ', '\u200c'), {
        minLength: length,
        maxLength: length,
      }),
      zwnjOnly: fc.array(fc.constantFrom('', '\u200c'), {
        minLength: length,
        maxLength: length,
      }),
    })
    .map(({ substitutions, separator, zwnjOnly }) => ({
      query,
      normalized,
      spacedVariant: unfold(normalized, substitutions, separator),
      zwnjVariant: unfold(normalized, substitutions, zwnjOnly),
    }))
})

describe('normalizePersian (property laws)', () => {
  it('is idempotent: normalizing twice is normalizing once', () => {
    fc.assert(
      fc.property(arbText, text => {
        const once = normalizePersian(text)
        expect(normalizePersian(once)).toBe(once)
      }),
      { seed: SEED, numRuns: 100 },
    )
  })

  it('matches its own normalized text, and is defined exactly when that text is searchable', () => {
    fc.assert(
      fc.property(arbFoldingCase, ({ query, normalized }) => {
        const pattern = buildVariantInsensitivePattern(query)
        if (hasSearchableChar(normalized)) {
          expect(pattern).toBeDefined()
          expect(pattern!.test(normalized)).toBe(true)
        } else {
          expect(pattern).toBeUndefined()
        }
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('finds every spelling and half-space placement of the folding class', () => {
    fc.assert(
      fc.property(arbFoldingCase, ({ query, spacedVariant }) => {
        const pattern = buildVariantInsensitivePattern(query)
        const normalized = normalizePersian(query)
        if (!hasSearchableChar(normalized)) return
        expect(pattern!.test(spacedVariant)).toBe(true)
      }),
      { seed: SEED, numRuns: 75 },
    )
  })

  it('a query written in any spelling finds the canonical text', () => {
    fc.assert(
      fc.property(arbFoldingCase, ({ normalized, zwnjVariant }) => {
        if (!hasSearchableChar(normalized)) return
        // Respelling inside the folding class and re-joining with half-spaces
        // folds back to exactly the same canonical text …
        expect(normalizePersian(zwnjVariant)).toBe(normalized)
        // … so a query typed that way matches the normalized text.
        expect(
          buildVariantInsensitivePattern(zwnjVariant)!.test(normalized),
        ).toBe(true)
      }),
      { seed: SEED, numRuns: 75 },
    )
  })
})
