# ADR-0012: The model proposes Capture Drafts; only a Capture Commit writes rows

- **Status:** Accepted (2026-11-08)
- **Deciders:** Tali owner + developer (capture design grilling)
- **Related:** ADR-0005 (reminder firing: server-side writes already bypass the
  outbox), ADR-0002 (preferences are server-of-record), ADR-0011 (visibility
  policy — a draft has none until it becomes a row), ADR-0004 (recurrence is a
  structured rule), ADR-0006/0007 (habit shape and eras), ADR-0010 (Effect
  version catalog)

## Context

Users write in bursts: "فردا ساعت ۵ دکتر، یادم باشه قرص رو بگیرم، پنجشنبه مهمونی
ساراست و باید کادو بخرم". Today each of those is a separate form on a separate
screen with its own required fields. Capture is the one screen where free text
goes in and real rows come out, using a model that dissects the text with a set
of tools.

The obvious implementation is for the model's tools to call the create services
directly. That is wrong for this product for four reasons:

- **Free text over-generates.** A paragraph reliably produces five things, of
  which one is misread and one is a hallucination. Direct writes make every
  mistake permanent before the user has seen it.
- **Rows are shared.** Tasks and events default to `shared` (ADR-0011), so a
  wrong row lands in the partner's feed and mirror within a pull. "Undo" is not
  a local action; it is five tombstones across five aggregates plus feed churn.
- **The create services are opinionated.** Visibility resolution, recurrence
  decoding, reminder `fireAt` derivation, habit `startedOn` and era 0, note plain
  text, tag/project ownership, replay dedupe and version CAS all live in the
  services. A second, model-shaped write path would re-implement them badly.
- **The product is not a chatbot.** The owner's constraint was explicit: tools
  that dissect the input, no conversation. Any design that resolves ambiguity by
  asking the model again is out of scope by construction.

There is no AI code or credential in the repo today; the API is a Cloudflare
Worker (Alchemy-managed) with Effect 4.1 services, a single `POST /rpc` RPC
endpoint, a client-side-only sync outbox, and a documented 50-statements-per-D1-
invocation budget.

## Decision

### 1. Draft, never write

The **Dissect** run gets the user's text and a set of draft tools. Each tool
validates its input against the domain draft schema and appends the result to a
per-run `Ref`. No tool holds a D1 handle. A dissect request therefore cannot
write a row, touch the sync feed, or change a partner's mirror — by construction,
not by convention.

An invalid tool call returns a tool error naming the failing field. TanStack AI
hands that back to the model and the run continues, so the model repairs its own
malformed date or empty title within the same run. A draft that fails twice is
accepted as a **Needs Input** card rather than silently dropped.

### 2. One tool per aggregate, five aggregates

`draft_task`, `draft_event`, `draft_note`, `draft_habit`, `draft_reminder`, each
with its own tight schema and a Persian description of when to use it. A
discriminated-union `add_item` tool was rejected: unions are the least reliable
schema shape to call. Per-aggregate tools also confine a bad call to one type.

The run creates **nothing else**: no list items, no occasions, no projects, no
tags, and no edits to existing rows. Mutation of existing rows needs entity
resolution and, for recurring events, the edit-scope/series-split flow — a
separate feature with worse failure modes than creation.

### 3. The draft union lives in the domain

`CaptureDraft` (`packages/domain/src/capture.ts`) is a discriminated union
mirroring the five create inputs with every field optional, plus `sourceQuote`
and `missing: [{ field, question }]`. It is shared with the client through
`@tali/rpc`, so the review UI is typed and the commit path cannot construct an
invalid input: `toCreateInput` runs the **real** create schema, and a draft that
fails it fails the commit before anything is written.

`sourceQuote` is required and verbatim. It is the main trust signal on the card
("that is the sentence I meant") and the way a hallucinated item is spotted. No
confidence score: model self-reports are uncalibrated and invite a sort order
nobody can trust.

### 4. Needs Input is a typed field, not a conversation

A field the text does not supply and the model may not invent becomes a
**Needs Input** entry carrying a typed shape (instant, local date, clock time,
frequency, repeat), and the card renders the real picker — the same Jalali
date/time input the app already has. No second model call, no free-text answer,
no clarification turn.

Which fields may be filled silently is a rule, not a judgement: **only fields
editable on the card** (title, and the one structural field — when, frequency,
repeat). Everything else — any date, time, duration, recurrence or reminder fire
time the words do not imply — is asked. Enumerable structural defaults are filled
without asking: task status `todo`, an event with a date but no time is all-day, a
reminder's kind is `general`, a habit with no stated rhythm is `daily`.

A **Capture Commit** is blocked while any visible draft still has an unanswered
Needs Input, and the button says why. Discarding the card unblocks. Nothing the
model flagged disappears without the user saying so.

### 5. Commit validates everything, then applies through the services

`CommitCapture` takes the reviewed drafts. It validates every draft against its
real create schema first — one bad card fails the request with a typed error
naming it, and nothing is written. Then it calls the existing create services in
order, each with a deterministic `clientMutationId` derived from
`(captureId, draftIndex, draftHash)`.

That gives the properties the alternative designs lose:

- every domain invariant is reused, not re-implemented;
- a partial failure is benign — the earlier rows are reported by id and a retry
  replays the same keys, which `applied_mutations` dedupes;
- no single D1 batch has to hold five creates (~5–7 statements each), so the
  documented 50-statement invocation budget is never in play.

A single atomic batch via `SyncRepo` primitives was rejected: it buys atomicity
at the price of duplicating five create paths and running close to the statement
ceiling. A queued apply job was rejected as a state machine for what is usually
five rows.

### 6. The Capture row is server-of-record, not sync data

The `capture` table (`id, owner_id, text, status, drafts, created_ids, error,
created_at, committed_at`) is owner-only and outside the sync machinery: no
version CAS, no feed entry, no partner visibility question — the same shape as
`user_preferences` under ADR-0002. Capture requires the network (the model is
remote), so there is nothing to queue offline, and the raw text of everything a
user ever typed does not belong in the household feed. Rows are purged after 90
days by the existing maintenance cron.

The row is kept because it buys three things a stateless screen cannot: history
("what did I capture yesterday"), evidence when a parse was bad, and the ability
to resume a review after a reload. It does **not** buy revert: fixing a
mis-created row is done in that row's own screen.

### 7. The Extractor is a service with a swappable Layer

`Extractor` is a `Context.Service` with an `ExtractorLive` layer (TanStack AI +
`@tanstack/ai-effect` + the `@tanstack/ai-openai` compatible adapter, base URL /
model / key from env) and a replay layer for tests. The provider is OpenCode
Go's OpenAI-compatible endpoint
(`https://opencode.ai/inference/go/openai/v1`) with `deepseek-v4.1-flash` by
default. The gateway requires an `x-opencode-session` header on every request
and a non-generic User-Agent; both ride the adapter's `wrapFetch` middleware.
`stream: false` with tools is verified against the live endpoint. Changing
provider later is one layer, not a rewrite; tests and the eval harness never
call a model.

Note the platform constraint: OpenCode's free model ids are restricted to the
OpenCode client, so a Worker uses paid ids.

### 8. Persian in, Persian out, with server-side context

Input is Persian for now. The prompt, tool descriptions and Needs Input copy are
Persian; the user's own wording is never rewritten. "Now", the IANA zone and the
week start come from the user's preferences **on the server** — preferences are
the server-of-record (ADR-0002), so the parse and the commit agree about what
"tomorrow" meant, and the prompt is reproducible in a test.

The server normalizes Persian and Arabic-Indic digits inside validated field
values (never inside titles or bodies). A Note draft is plain text; the server
wraps it into a minimal ProseMirror doc, because a model-authored ProseMirror
tree is a large artifact nobody can validate.

### 9. Bounded and observable

4000-character input, 12 drafts, 60-second timeout, one retry, 20 captures per
user per hour using the fixed-window limiter pattern already used for login
attempts, and a 60-second identical-text dedupe that returns the existing capture
instead of paying for a second run.

### 10. Silence is not a result

Non-actionable prose becomes a Note (title from the first line, body the text) —
the catch-all is a note, not a drop. An empty or whitespace input shows an empty
state and keeps the text. A model or network failure marks the capture `failed`
with a retry, and the text stays in the Foldkit Model and in `localStorage` so a
reload or a crash cannot lose a thought.

The caps in §9 are abuse protection, not per-call cost control: a Go
subscription is a monthly included allowance per model (DeepSeek V4.1 Flash
carries a $100/month allowance), so a runaway loop is the risk, not the price of
one call.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Tools write rows directly; undo offered afterwards | Every misread is visible to the partner before the user can react; undo is five tombstones plus feed churn. |
| Hybrid: unambiguous items auto-commit | Two code paths and a screen whose contents cannot be predicted — the property that makes review worth having. |
| Single structured-output call, no tools | Most reliable schema, but no per-item validation feedback, and it discards the tool framing this feature was specified with. |
| Free-text Needs Input answered by a second model call | Doubles cost and latency on exactly the messy inputs, and a re-parse can return a different draft. |
| Capture rows as a syncable `ownerOnly` aggregate | Puts raw free text and LLM metadata into the household feed machinery for no gain; capture cannot happen offline anyway. |
| LLM call from the browser | Puts a paid credential in the page and bypasses the services' viewer context. |
| One D1 batch for the whole commit | Duplicates five create paths and risks the 50-statement budget. |
| Revert a capture across all its rows | A new cross-aggregate delete path with its own conflict rules, for a mistake review already prevents. |

## Consequences

- **New dependencies:** `@tanstack/ai`, `@tanstack/ai-effect`,
  `@tanstack/ai-openai` (its `compatible` subpath), added to the pnpm catalog
  (ADR-0010) and referenced as `catalog:`; the whole stack stays on Effect 4.1.
- **New deploy config:** an API key secret plus `CAPTURE_MODEL` and
  `CAPTURE_BASE_URL` vars in `infra/alchemy.run.ts`, `.env.example`, and the
  deploy workflow's secrets. The feature is inert without them, and the
  `Extractor` layer must fail with a typed error rather than a raw fetch failure.
- **New table + migration + purge:** the nightly maintenance cron gains a
  capture purge; a restore drill covers the table for free because it is in D1.
- **No offline capture.** The capture page is the one write surface that needs a
  connection; this is a product-visible exception to the offline-first story and
  must be said in the UI.
- **Cost is now a per-feature concern.** Every capture is a paid remote call;
  the caps in §9 are the whole enforcement, and the eval harness is what keeps a
  prompt edit from quietly degrading quality.
- **Vocabulary:** `Capture`, `Capture Status`, `Dissect`, `Capture Draft`,
  `Source Quote`, `Needs Input` and `Capture Commit` enter `GLOSSARY.md`.
  "Inbox" stays reserved for the **Missed Inbox**.
- **Growth path:** list items and occasions are additive tool + draft variants;
  editing existing rows is a separate ADR, because it needs entity resolution and
  the recurring-event edit-scope flow.
