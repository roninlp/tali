# Research: D1 full-text search for Persian notes

**Ticket:** https://github.com/roninlp/tali/issues/12
**Question:** What are the options for full-text search over Persian notes on D1 (SQLite)? Does D1 support FTS5, and how does one do Persian normalization (half-space/ZWNJ, hamze/yeh variants, diacritics) + result highlighting? Compare FTS5 (unicode61/trigram, custom tokenizers) vs a trigram index vs in-app scan, and recommend what the notes search should use.
**Resolved:** 2026-10-16

---

## TL;DR (the decision)

Use **SQLite FTS5** — D1 ships it natively — with **application-side Persian normalization** applied to both the stored `Note.plainText` and the query, and the **`unicode61` tokenizer + a prefix index**. Rank with `rank`/`bm25()`, and highlight with `highlight()`/`snippet()`.

- **D1 supports FTS5** (including `fts5vocab`) out of the box; the **trigram tokenizer is also available**. There is **no** custom-tokenizer escape hatch: D1 exposes only the built-in subset of SQLite extensions, and FTS5 custom tokenizers are written in C (via `sqlite3_bind_pointer`), which D1 does not let you load.
- The built-in tokenizers do **not** understand Persian. `unicode61`'s `remove_diacritics` is **Latin-only**, and both `unicode61` and `trigram` treat the half-space (ZWNJ, U+200C) and Arabic diacritics as separators/non-token characters, so variant-insensitive search has to be done **in app code**, not in the tokenizer.
- Therefore: **normalize in JS/TS** (yeh/hamze/kaf/alef variants, strip harakat + tatweel, remove ZWNJ) before indexing and before querying, then let FTS5 do word matching, ranking and highlighting. This is exactly what the domain model already intends (`Note.plainText` "Persian-normalized at write time" — `docs/domain-model-draft.md` §3.7).
- **Trigram** is the right *complement*, not the default: use it only if the product needs arbitrary substring ("contains") matching. It is variant-*blind* too (it indexes raw 3-char windows), so normalization is still required, and it gives poorer ranking/highlighting than word tokens.
- **In-app scan** is the fallback only (tiny corpora / offline). It cannot hit the <300ms target at scale and reimplements ranking + highlighting by hand.

---

## 1. Does D1 support FTS5?

Yes. D1 runs a managed SQLite engine and exposes FTS5 as one of a small set of compiled-in extensions.

> "D1 supports a subset of SQLite extensions for added functionality, including: **FTS5 module** … for full-text search (including `fts5vocab`), JSON extension …, Math functions."

- Source: https://developers.cloudflare.com/d1/sql-api/sql-statements/ ("Supported SQLite extensions").
- The authoritative "what is actually compiled in" is Cloudflare's workerd source: `src/workerd/util/sqlite.c++#L269` (linked from that same page).

Two further facts follow from the docs:

1. **FTS5 is part of the SQLite core since 3.9.0 (2015)** — it is in the amalgamation, enabled by `SQLITE_ENABLE_FTS5`, not a loadable extension you have to opt into. Source: https://www.sqlite.org/fts5.html §2.1.
2. **The trigram tokenizer is available on D1.** Cloudflare's own index guidance explicitly recommends it:

   > "For arbitrary substring searches, consider **FTS5 with the trigram tokenizer** …, which can optimize patterns containing at least three consecutive non-wildcard Unicode characters."

   - Source: https://developers.cloudflare.com/d1/best-practices/use-indexes/ (row: `WHERE column LIKE '%term%'`).
   - The trigram tokenizer is part of `fts5.c` itself (registered alongside `unicode61`/`ascii` in `fts5_tokenize.c`), so "FTS5 is available" implies "trigram is available". Source: https://www.sqlite.org/fts5.html §4.3.4; `sqlite/ext/fts5/fts5_tokenize.c`.

### 1.1 Custom tokenizers are NOT available on D1

FTS5 can be extended with custom tokenizers and auxiliary functions, but **only in C**, by obtaining the `fts5_api` pointer via the `fts5()` SQL function + `sqlite3_bind_pointer()` and registering an `fts5_tokenizer_v2` struct. Source: https://www.sqlite.org/fts5.html §7–§7.1.

D1 exposes **only** the built-in extension subset (FTS5, JSON, math) and gives you no way to load arbitrary C extensions or bind pointers. So a bespoke "Persian-aware FTS5 tokenizer" is **off the table on D1**. Persian normalization must live in application code (which is also the only layer that can be shared by the web + api packages anyway).

---

## 2. Why Persian can't rely on the built-in tokenizers alone

### 2.1 `unicode61` (the default)

- Classifies characters as token vs separator by Unicode general category: **`L*` (letters), `N*` (numbers), `Co` (private use)** are tokens; everything else is a separator. Source: https://www.sqlite.org/fts5.html §4.3.1.
- `remove_diacritics` (values 0/1/2) **removes diacritics from Latin script only**. Both the default ("diacritics are removed from all Latin script characters") and `remove_diacritics=2` ("correctly removed from all **Latin** characters") are Latin-scoped. Source: https://www.sqlite.org/fts5.html §4.3.1.

Consequences for Persian:

| Issue | Codepoints | What `unicode61` does | Consequence |
|---|---|---|---|
| Half-space / ZWNJ (نیم‌فاصله) | U+200C (category `Cf`) | treated as a **separator** | `می‌روم` is split into tokens `می` + `روم`, so it won't match the attached `میروم`, and phrase queries break |
| Harakat (diacritics) | U+064B–U+065F, U+0670, U+06D6–U+06ED (category `Mn`) | treated as a **separator** (and never removed — `remove_diacritics` is Latin-only) | a vocalized word is split at each diacritic |
| Yeh variants | ی U+06CC (Farsi) vs ي U+064A (Arabic) vs ى U+0649 | both are letters → **distinct tokens** | `میروم` ≠ `ميروم` |
| Kaf variants | ک U+06A9 vs ك U+0643 | distinct tokens | `کتاب` ≠ `كتاب` |
| Hamze/alef variants | أ إ آ ء ئ ؤ | distinct tokens | `أحمد` ≠ `احمد` |

### 2.2 `trigram`

- Indexes every overlapping 3-character window and supports substring matching + indexed `LIKE`/`GLOB`. Source: https://www.sqlite.org/fts5.html §4.3.4.
- Its own `remove_diacritics` option is folded through the same Unicode case-folding path (`sqlite3Fts5UnicodeFold`) as `unicode61`, i.e. Latin-oriented, and its `case_sensitive=0` folding is ASCII+Latin. Source: `sqlite/ext/fts5/fts5_tokenize.c` (the trigram fold loop).

Consequence: trigram is **variant-blind** — it does not know ی and ي are the same letter, so a query written one way still won't match text written the other way. Normalization is still mandatory. What trigram *does* buy you is word-boundary independence: it indexes raw character windows, so it is naturally resilient to the ZWNJ/space boundary problem that breaks `unicode61`'s word tokens.

### 2.3 Conclusion

No tokenizer solves Persian. **Normalization is the real work; the tokenizer is just the index structure.** Do normalization once in app code (shared between write and query paths), then choose the tokenizer purely for its matching/ranking/highlighting semantics.

---

## 3. Persian normalization (the reusable function)

One function, applied to **every** string before it is indexed *and* before it is queried. It must be deterministic and cheap (runs per note-write and per search). Character maps follow the widely-used Persian normalizers (hazm / virastar / NLTK Arabic-stem conventions) — the exact mapping table is what the tests pin down.

```ts
// packages/domain/src/persian.ts  (pure, no deps — usable by web + api)
const CHAR_MAP: Record<string, string> = {
  "\u064A": "\u06CC", // ي Arabic yeh          -> ی Farsi yeh
  "\u0649": "\u06CC", // ى alef maksura        -> ی
  "\u0643": "\u06A9", // ك Arabic kaf          -> ک Farsi kaf
  "\u0629": "\u0647", // ة teh marbuta         -> ه
  "\u0623": "\u0627", // أ alef+hamza above    -> ا
  "\u0625": "\u0627", // إ alef+hamza below    -> ا
  "\u0622": "\u0627", // آ alef+madda          -> ا
  "\u0624": "\u0648", // ؤ waw+hamza           -> و
  "\u0626": "\u06CC", // ئ yeh+hamza           -> ی
  "\u0621": "",       // ء standalone hamza    -> remove
  "\u0640": "",       // ـ tatweel             -> remove
  "\u200C": "",       //  ZWNJ half-space      -> remove (join morphemes)
  "\u200D": "",       //  ZWJ                  -> remove
}

// Harakat + Quranic marks + other non-spacing Arabic marks: strip.
// U+064B–U+065F, U+0670, U+06D6–U+06ED, U+06DF, U+06E0, U+06E2–U+06E4, U+06E7–U+06E8, U+06EA–U+06ED
const HARAKAT = /[\u064B-\u065F\u0670\u06D6-\u06ED\u06DF\u06E0\u06E2-\u06E4\u06E7-\u06E8\u06EA-\u06ED]/g

export function normalizePersian(input: string): string {
  return input
    .normalize("NFKC")                       // collapse Arabic presentation forms U+FB50–U+FEFF
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u06DF\u06E0\u06E2-\u06E4\u06E7-\u06E8\u06EA-\u06ED]/g, "")
    .replace(/[\u064A\u0649\u0643\u0629\u0623\u0625\u0622\u0624\u0626\u0621\u0640\u200C\u200D]/g, (c) => CHAR_MAP[c])
    .replace(/\s+/g, " ")                     // collapse whitespace (leave real spaces as word boundaries)
    .trim()
}
```

Notes / decisions embedded above:

- **Yeh/hamze/kaf/alef → canonical Persian letter** — this is the core variant-resilience win (issue title's "hamze/yeh variants").
- **Harakat + tatweel stripped** — because `unicode61` would otherwise split the word at each mark (they're `Mn`, not `L*`), and `remove_diacritics` won't remove them.
- **ZWNJ removed** — so half-space spellings (`می‌روم`) collapse onto the attached spelling (`میروم`). A *full* space is left as a real word boundary (semantically correct: half-space compounds are single words). The one case normalization deliberately does **not** bridge is "space vs half-space vs attached" for the *same* compound written with a full space (`می روم`); if that matters, add the trigram table (§5) — see §4.
- **NFKC** first, so Arabic presentation-form codepoints (e.g. a yeh written in its isolated presentation form U+FBEC) don't evade the character map.

Apply it at **write** (when deriving `plainText` from the TipTap JSON) and at **query** (before building the `MATCH` expression). The stored `plainText` should be the normalized form.

---

## 4. Comparing the options

| Option | Works on D1? | Persian variant-resilient? | Ranking | Highlighting | Notes |
|---|---|---|---|---|---|
| **FTS5 + `unicode61` + app normalization** ✅ | Yes (built-in) | Yes (normalization is in app code) | Yes — `bm25`/`rank` | Yes — `highlight()`/`snippet()` | Default. Clean word tokens, prefix indexes, phrase/NEAR/boolean queries. |
| **FTS5 + `trigram` + app normalization** | Yes (built-in) | Yes (normalization in app code) | Weak — `bm25` over 3-char windows is not meaningful | Poor — `highlight`/`snippet` are token-oriented; matches are substrings | Use only for substring ("contains") search. Substrings <3 chars never match. |
| **FTS5 + custom Persian tokenizer** | **No** | n/a | n/a | n/a | Requires C + `sqlite3_bind_pointer`; D1 only exposes the built-in subset (§1.1). |
| **Hand-rolled trigram index** (own `note_trigram` table) | Yes | Yes (app code) | DIY | DIY | Reimplements exactly what FTS5 `trigram` already does; more code, no `highlight`/`snippet`. Only if you must avoid a virtual table. |
| **In-app scan** (load all notes, filter in JS) | Yes | Yes (app code) | DIY | DIY | Fine for a few hundred notes; **not** <300ms at scale, no index, bills for every row scanned (D1 charges rows read). Fallback only. |

**Why `unicode61` over `trigram` for the default:**

- Persian note search is **word search** ("find my note about دارو"). `unicode61` gives real word tokens, which is what `bm25` ranking and `snippet()` highlighting are designed around. Source: https://www.sqlite.org/fts5.html §5.1.
- Prefix matching ("دار*" → دارو، داروخانه) is cheap and explicit via the `prefix='1 2 3'` option — a very Persian-relevant feature (inflected/derived forms). Source: https://www.sqlite.org/fts5.html §4.2.
- `trigram`'s substring matching is the thing you add **if and when** "contains" semantics are a product requirement. Note its edge cases: tokens <3 chars match nothing, and `highlight()`/`snippet()` degrade. Source: https://www.sqlite.org/fts5.html §4.3.4.

**Why normalization lives in app code regardless:** §2.3.

---

## 5. Highlighting

FTS5 ships three built-in auxiliary functions, all invoked with the table name as the first argument. Source: https://www.sqlite.org/fts5.html §5.1.

- **`highlight(fts, colIdx, before, after)`** — returns the *whole* column with every phrase match wrapped in `before`/`after`. Source: §5.1.2.
- **`snippet(fts, colIdx, before, after, ellipsis, maxTokens)`** — returns a short fragment that maximizes distinct matched terms; `maxTokens` must be 1–64. Source: §5.1.3.
- **`bm25(fts, w0, w1, …)`** / the hidden **`rank`** column — lower = better; `ORDER BY rank` is the fast path. Source: §5.1.1, §5.2.

Highlighting caveat for normalized Persian: `highlight()`/`snippet()` operate on the **stored FTS content**, which (with normalization) is the *normalized* `plainText`, not the raw TipTap text. Persian normalization is visually near-identical in the common cases (ي→ی, ك→ک, ة→ه, ء removed), so highlighting the normalized text is acceptable for search-result snippets. If exact highlighting over the original text is required later, do a second app-side pass (locate the normalized query terms in the original text with a variant-aware match) rather than trusting FTS offsets. For MVP, render `snippet()` of the normalized `plainText`.

---

## 6. Recommendation + migration / query sketch

### 6.1 Schema (migration, applied out-of-band via `wrangler d1 migrations apply`)

D1 has no interactive transactions and Effect's `Migrator` can't run on it (`docs/research/effect-drizzle-d1.md` §6), so this is a plain migration file. Notes use a **TEXT UUID v7** `id` (domain model §3.7), so we key the FTS table on the note's **implicit integer `rowid`** (every SQLite table has one unless `WITHOUT ROWID`), and use an **external-content** table so we don't duplicate the text and `highlight()`/`snippet()` read straight from `notes`.

```sql
-- 0002_note_fts.sql
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  plainText,
  content = 'notes',          -- external content: FTS stores index only, text stays in `notes`
  content_rowid = 'rowid',    -- key on notes' implicit INTEGER rowid
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '1 2 3'            -- enable 1/2/3-char prefix indexes for "دار*"
);
```

`title` and `plainText` are **already normalized** before reaching the index (§3). `remove_diacritics 2` is harmless (Latin-only) and future-proofs any Latin content in the same table.

### 6.2 Keeping the index in sync

Two valid mechanisms. **Prefer app-side `batch()`** — it matches this repo's settled "no interactive transactions → atomic multi-statement via `D1Client.batch()`" convention (`docs/domain-model-draft.md` §1, `docs/research/effect-drizzle-d1.md` §7) and avoids trigger/migration quirks.

**Option A — app-side sync (recommended).** Write the note and its FTS row in one atomic batch; the FTS row reuses the note's `rowid`:

```ts
// packages/sql/src/note-repo.ts (sketch — @effect/sql-d1 SqlClient)
import { SqlClient, SqlSchema } from "effect/sql"
import { Schema, Effect } from "effect"
import { normalizePersian } from "@tali/domain/persian"

const insertWithIndex = (note: NoteInsert) =>
  sql.batch([
    sql`INSERT INTO notes ${sql.insert(note)} RETURNING rowid`,
    sql`INSERT INTO notes_fts(rowid, title, plainText)
        VALUES (last_insert_rowid(), ${note.title}, ${normalizePersian(plainText(note))})`
  ])
```

On update/delete, mirror into `notes_fts` with the same `rowid` (delete via the FTS5 `'delete'` command: `INSERT INTO notes_fts(notes_fts, rowid, title, plainText) VALUES('delete', $rowid, $oldTitle, $oldPlainText)`). Source: https://www.sqlite.org/fts5.html §6.3.

**Option B — SQL triggers** (drop the app-side writes). D1 supports triggers, and they fire atomically within the triggering statement; note Cloudflare's own marketing calls out "full-text search triggers". Source: https://developers.cloudflare.com/d1/sql-api/sql-statements/ (trigger-related PRAGMAs) and the D1 product page. Caveat: there is a reported community issue where `CREATE TRIGGER` inside a `wrangler d1 migrations apply` migration fails while the same statement works as a direct query — so if you go this route, apply triggers out-of-band and test in Miniflare first.

### 6.3 Query + highlight sketch

Normalize the query, then `MATCH` with ranking + snippet:

```ts
const searchNotes = (q: string) =>
  sql<{ id: string; title: string; snippet: string }>`
    SELECT n.id, n.title,
           snippet(notes_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet
    FROM notes_fts f
    JOIN notes n ON n.rowid = f.rowid
    WHERE notes_fts MATCH ${normalizePersian(q)}
      AND n.deletedAt IS NULL
    ORDER BY rank
    LIMIT 50
  `
```

- `normalizePersian(q)` makes the query spelling-variant-resilient (ی/ي, ک/ك, half-space, diacritics).
- `ORDER BY rank` = `bm25` ascending (best first). Source: https://www.sqlite.org/fts5.html §5.2.
- Prefix queries need no extra work — the `prefix='1 2 3'` index makes `دار*` fast; append `*` to the last token when the product wants "type-ahead".
- `snippet(…, 1, …)` highlights column index 1 (`plainText`); use `highlight()` (column 1) for the full normalized body. Source: https://www.sqlite.org/fts5.html §5.1.2–§5.1.3.

**Performance vs the <300ms target:** FTS5 `MATCH` is an inverted-index probe + merge — single-digit ms on D1 even for tens of thousands of notes; well inside budget. (D1 bills rows read, so the index also keeps the bill down; a bare `LIKE '%x%'` would be a full scan. Source: https://developers.cloudflare.com/d1/best-practices/use-indexes/.) Run `INSERT INTO notes_fts(notes_fts) VALUES('optimize')` / `'rebuild'` only from a migration/maintenance job, never per request (D1 best-practice: no schema/heavy work on the hot path).

### 6.4 If substring ("contains") search is later required

Add a **second** FTS5 table using the trigram tokenizer over the *same* normalized text, querying it only for the "contains" path:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_tri USING fts5(
  title, plainText, content='notes', content_rowid='rowid',
  tokenize = "trigram"
);
-- contains query:
-- SELECT … FROM notes_fts_tri f JOIN notes n ON n.rowid = f.rowid
--   WHERE notes_fts_tri MATCH ${normalizePersian(q)}
```

Keep the `unicode61` table as the primary relevance-ranked path. Source: https://www.sqlite.org/fts5.html §4.3.4, https://developers.cloudflare.com/d1/best-practices/use-indexes/.

---

## 7. Recommendation summary

| Need | Use |
|---|---|
| Search backend | FTS5 (native on D1) |
| Persian variant-resilience | `normalizePersian()` in app code (yeh/hamze/kaf/alef, strip harakat+tatweel, drop ZWNJ), applied to write **and** query |
| Tokenizer | `unicode61 remove_diacritics 2` + `prefix='1 2 3'` |
| Ranking | `ORDER BY rank` (`bm25`) |
| Highlighting | `snippet()` (result list) / `highlight()` (full body) over normalized `plainText` |
| Substring ("contains") search | optional second `trigram` table over the same normalized text |
| Custom tokenizer | not possible on D1 (C-only, not loadable) |
| In-app scan | fallback only (tiny corpora / offline) |
| Sync | app-side `D1Client.batch()` (recommended) or SQL triggers (test the migration quirk) |
| Migrations | plain SQL via `wrangler d1 migrations apply` (Effect `Migrator` can't run on D1) |

**Packages / versions (as of writing):** `effect` / `@effect/sql-d1` **4.0.5** (vendored at `repos/effect`); D1 = managed SQLite (FTS5 + trigram built in); normalization is a pure function in `packages/domain` (shared by web + api).

---

## 8. Sources

- Cloudflare D1 — SQL statements / supported extensions (FTS5, `fts5vocab`, workerd `sqlite.c++` link): https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Cloudflare D1 — Use indexes (trigram-tokenizer recommendation, `LIKE '%…%'` full-scan warning, billing-by-rows-read): https://developers.cloudflare.com/d1/best-practices/use-indexes/
- Cloudflare D1 — Limits (30s query cap, 100KB statement, 2MB row): https://developers.cloudflare.com/d1/platform/limits/
- SQLite FTS5 reference (tokenizers: `unicode61`/`ascii`/`porter`/`trigram`; `remove_diacritics` Latin-scope; prefix indexes; external-content/contentless tables; auxiliary functions `bm25`/`highlight`/`snippet`/`rank`; special `delete`/`optimize`/`rebuild` commands; custom-tokenizer C API): https://www.sqlite.org/fts5.html
- SQLite `fts5_tokenize.c` (trigram fold loop, built-in tokenizer registration): https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_tokenize.c
- Repo: `docs/domain-model-draft.md` §3.7 (`Note.plainText` "Persian-normalized at write time"), §1 constraints; `docs/research/effect-drizzle-d1.md` (§6 migrations, §7 batch/atomicity); `repos/effect/packages/sql/d1/src/D1Client.ts` (tagged-template SQL, `batch()`, no `withTransaction`).
