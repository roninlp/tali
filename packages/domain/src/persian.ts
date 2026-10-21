/**
 * Persian text normalization (ticket #41; FR-NOTE-04).
 *
 * Source: `docs/research/d1-persian-fts.md` §3. SQLite's built-in tokenizers
 * (`unicode61`, `trigram`) know nothing about Persian: they treat the
 * half-space (ZWNJ) and the harakat as separators, and they treat the Arabic
 * and Farsi spellings of yeh and kaf as different letters. D1 also has no
 * custom-tokenizer escape hatch (that is C-only), so the normalization has to
 * live in application code.
 *
 * One function is applied to **every** string before it is indexed and before
 * it is queried, so a note written in one spelling is found by the other:
 *
 * - `ي`/`ى` → `ی`, `ك` → `ک`, `ة` → `ه`, the hamza carriers → their bare
 *   letters, `ء` and the tatweel are dropped;
 * - the harakat (and the Quranic marks) are stripped, because `unicode61`
 *   would otherwise split a vocalized word at every mark;
 * - the half-space (ZWNJ) is removed, so `می‌روم` and `میروم` are one token;
 * - Arabic-Indic (`٠-٩`) and Extended Arabic-Indic (`۰-۹`) digits become ASCII,
 *   so `۱۲۰` is found by `120`.
 *
 * A real space stays a word boundary: `می روم` (two words) is deliberately not
 * the same token as `می‌روم`.
 *
 * The function is pure and dependency-free, so the web app and the API share
 * one implementation — the client normalizes its query, the server normalizes
 * what it indexes.
 */

/** Arabic → Farsi letter folding. A missing key means "leave the char". */
const CHAR_MAP: Readonly<Record<string, string>> = {
  // ARABIC YEH, ALEF MAKSURA → FARSI YEH
  "\u064A": "\u06CC",
  "\u0649": "\u06CC",
  // ARABIC KAF → KEHEH (Persian kaf)
  "\u0643": "\u06A9",
  // TEH MARBUTA → HEH
  "\u0629": "\u0647",
  // ALEF WITH HAMZA ABOVE / BELOW / MADDA → ALEF
  "\u0623": "\u0627",
  "\u0625": "\u0627",
  "\u0622": "\u0627",
  // WAW WITH HAMZA → WAW
  "\u0624": "\u0648",
  // YEH WITH HAMZA → FARSI YEH
  "\u0626": "\u06CC",
  // STANDALONE HAMZA, TATWEEL → dropped
  "\u0621": "",
  "\u0640": "",
  // ZERO WIDTH NON-JOINER (half-space), ZERO WIDTH JOINER → dropped
  "\u200C": "",
  "\u200D": ""
}

/** The characters `CHAR_MAP` folds. */
const FOLDABLE = /[\u064A\u0649\u0643\u0629\u0623\u0625\u0622\u0624\u0626\u0621\u0640\u200C\u200D]/g

/**
 * Harakat, sukun, shadda, superscript alef, the Quranic annotation marks and
 * the other non-spacing Arabic marks. All are `Mn`, so `unicode61` treats them
 * as separators and would split the word at every one of them.
 */
const HARAKAT =
  /[\u064B-\u065F\u0670\u06D6-\u06ED\u06DF\u06E0\u06E2-\u06E4\u06E7-\u06E8\u06EA-\u06ED]/g

/** Arabic-Indic (`٠-٩`) and Extended Arabic-Indic (`۰-۹`) digits. */
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g

const ARABIC_DIGIT_BASE = 0x0660
const EXTENDED_ARABIC_DIGIT_BASE = 0x06F0

/**
 * Fold a Persian string to its canonical form.
 *
 * Idempotent: normalizing an already-normalized string returns it unchanged,
 * so the write path and the query path can both call it.
 */
export const normalizePersian = (input: string): string =>
  input
    // NFKC folds the Arabic presentation forms (U+FB50–U+FEFF) so they cannot
    // evade the character map below.
    .normalize("NFKC")
    .replace(HARAKAT, "")
    .replace(FOLDABLE, (char) => CHAR_MAP[char] ?? "")
    .replace(ARABIC_DIGITS, (digit) => {
      const code = digit.codePointAt(0) ?? ARABIC_DIGIT_BASE
      const base = code >= EXTENDED_ARABIC_DIGIT_BASE
        ? EXTENDED_ARABIC_DIGIT_BASE
        : ARABIC_DIGIT_BASE
      return String(code - base)
    })
    .replace(/\s+/g, " ")
    .trim()

/**
 * The FTS5 `MATCH` expression for a user query.
 *
 * Every token is quoted, so a query can never be read as FTS5 syntax (a `-`,
 * a `*`, a `"` or a `:` are literal characters, not operators), and the last
 * token gets a prefix marker so typing `دار` already finds `دارو` — the
 * `prefix = '1 2 3'` index makes that cheap.
 *
 * Returns `undefined` when the query has no searchable token (empty input,
 * or punctuation only), which the caller turns into "no results" rather than
 * an FTS5 syntax error.
 */
export const buildSearchMatchQuery = (query: string): string | undefined => {
  const tokens = normalizePersian(query)
    .split(" ")
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
  if (tokens.length === 0) return undefined
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replace(/"/g, '""')}"`
      return index === tokens.length - 1 ? `${quoted}*` : quoted
    })
    .join(" ")
}

/**
 * Markers the server wraps a match in. They are control characters, so they
 * cannot occur in a note's text and never reach the DOM as markup: the client
 * splits on them and renders the matched runs as `<mark>` elements.
 */
export const SEARCH_MARK_OPEN = "\u0001"
export const SEARCH_MARK_CLOSE = "\u0002"

export interface SearchSegment {
  readonly text: string
  readonly match: boolean
}

/**
 * Split a marked string into plain and matched runs.
 *
 * The server sends the snippet FTS5 produced (with the markers) and splits it
 * here, so the wire shape is a list of segments rather than HTML: the client
 * renders text nodes and `<mark>` elements, and a note can never inject markup.
 */
export const splitSearchSegments = (marked: string): ReadonlyArray<SearchSegment> => {
  const segments: Array<SearchSegment> = []
  let buffer = ""
  let match = false
  const flush = (): void => {
    if (buffer === "") return
    segments.push({ text: buffer, match })
    buffer = ""
  }
  for (const char of marked) {
    if (char === SEARCH_MARK_OPEN) {
      flush()
      match = true
    } else if (char === SEARCH_MARK_CLOSE) {
      flush()
      match = false
    } else {
      buffer += char
    }
  }
  flush()
  return segments
}

/**
 * Character classes for a variant-insensitive matcher.
 *
 * The key is the canonical (normalized) character; the value is the set of
 * spellings that must match it. Used by the offline search in the web app,
 * where there is no FTS5 index to lean on.
 */
const VARIANT_CLASSES: Readonly<Record<string, string>> = {
  "\u06CC": "[\u06CC\u064A\u0649]", // yeh
  "\u06A9": "[\u06A9\u0643]", // kaf
  "\u0647": "[\u0647\u0629]", // heh / teh marbuta
  "\u0627": "[\u0627\u0623\u0625\u0622]", // alef and its hamza carriers
  "\u0648": "[\u0648\u0624]" // waw and its hamza carrier
}

const escapeRegExp = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A pattern that matches the query in any of its Persian spellings.
 *
 * The query is normalized first, so the pattern is built from the canonical
 * characters and matches the Arabic spellings through the variant classes.
 * An optional half-space is allowed between every two characters, so the
 * query `میروم` matches the text `می‌روم` as well as `میروم`.
 *
 * Returns `undefined` for a query with no searchable character.
 */
export const buildVariantInsensitivePattern = (query: string): RegExp | undefined => {
  const normalized = normalizePersian(query)
  const chars = [...normalized]
  if (!chars.some((char) => /[\p{L}\p{N}]/u.test(char))) return undefined
  const source = chars
    .map((char) => {
      const variant = char === " " ? "[\\s\\u200C]+" : VARIANT_CLASSES[char] ?? escapeRegExp(char)
      // A separator (space or half-space) may sit between any two characters,
      // so the query `میروم` matches `می‌روم` and `می روم` alike.
      return `${variant}(?:\\s|\\u200C)?`
    })
    .join("")
  return new RegExp(source, "u")
}
