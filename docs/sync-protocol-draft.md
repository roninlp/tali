# Tali — Offline-first Sync Protocol (Draft)

> **Status:** PROTOTYPE — decision-ready draft for the owner + developer to settle live. Not a final contract.
> **Ticket:** [#8](https://github.com/roninlp/tali/issues/8) (HITL grilling — this doc prepares the decisions, it does not close them).
> **Builds on:** [#7](https://github.com/roninlp/tali/issues/7) `docs/domain-model-draft.md` (settled domain model) and the settled transport/DB decisions on the [map #1](https://github.com/roninlp/tali/issues/1).
> **Source authority:** `docs/must-have-feature-map.html` §7 (data & sync contracts), CC-02 ("Offline-first sync"), CC-03 ("Soft delete, undo, and trash"); `docs/research/effect-drizzle-d1.md` (D1 atomicity via `batch()`, no transactions); `docs/research/effect-rpc-solidstart.md` (sync = plain HTTP, not RPC).
> **Effect version:** v4.0.5 (vendored at `repos/effect`). Wire shapes are `@effect/schema` (`Schema.*`) codecs shared by `web` and `api` via `packages/domain`.

---

## 1. Guiding constraints (settled — do not re-litigate)

These come straight from the domain model and the map. The sync protocol **builds on them**, it does not change them.

1. Every syncable row carries a **server-monotonic per-row `version`** (`int`) + `updatedAt` (UTC datetime string). `version` bumps on every committed mutation **including soft-delete**.
2. IDs are **UUID v7**, **client-generated** (offline-first means the client mints IDs without the server).
3. **Soft delete** (`deletedAt` non-null) is a committed mutation; `deletedAt` carries the tombstone; 30-day trash purge (settled).
4. `private|shared` visibility — a client only ever sees `shared` items + its **own** `private` items (never the spouse's `private` items).
5. **D1 has no interactive transactions.** The only atomic multi-statement primitive is `D1Client.batch()`. Every multi-row sync commit must be expressed as one `batch()`.
6. **Transport:** sync pull/push + SSE are **plain HTTP** (not Effect RPC). RPC is reserved for aggregate CRUD/mutations. The *envelope* schemas live in `packages/domain` so `api` validates and `web` parses with the same codec.
7. **Conflict rules are settled in shape** (feature map §7 + CC-03): field-level LWW, checklist **done-wins**, recurrence **single-writer**, **tombstone-wins**, soft-delete **favors delete-with-recovery**. This draft pins down *where and how* those rules run — that part is the decision.
8. **Realtime wake-up:** an SSE channel per household whose only job is to *wake* clients; clients always re-`pull` to get actual data.

---

## 2. The two layers of ordering (the core mental model)

There are **two different monotonic numbers**, and conflating them is the classic sync bug. This draft separates them:

| Number | Where it lives | Assigned by | What it orders |
|---|---|---|---|
| **`version`** (per-row) | on every entity row | server, on commit | **conflicts** — "which of two edits to *this one row* wins" (LWW tiebreak, done-wins) |
| **`seq`** (global) | in a `change_feed` table | server, on commit | **the pull cursor** — "which changes has *this client* already seen, across all entity types" |

The domain model settled `version` (per-row, server-monotonic — map decision #8 explicitly rejected a household-global counter as the *conflict* field, because one shared counter is a hot spot and inflates every row's version with unrelated writes). But `version` is **per-row**, so a single scalar cursor cannot be compared across 11 entity tables. Pull needs a *global* monotonic sequence — which is what the `change_feed.seq` provides.

> **Why a `change_feed` and not just `version`?** The feature map §7 already says push "appends a change-feed entry", and "cursor pulls by version". The clean reconciliation is: **`change_feed` (global `seq`) is the pull list; per-row `version` is the conflict field.** A `change_feed` is *append-only* (new rows, not one mutated hot row), so it does not reintroduce the hot-spot problem the map's decision #8 was avoiding. It is still a live decision — see **DP-1**.

---

## 3. Cursor pull — `GET /sync/pull`

### 3.1 The change feed

```ts
// One row per committed mutation, append-only, global monotonic `seq`.
// Written in the SAME batch() as the entity mutation (atomic).
change_feed (
  seq         INTEGER PRIMARY KEY,   -- AUTOINCREMENT: the pull cursor
  entityType  TEXT,                  -- "habit" | "task" | "listItem" | ...
  entityId    TEXT,                  -- UUID v7 (branded id, validated at hydration)
  op          TEXT,                  -- "upsert" | "delete"  (delete = soft-delete tombstone)
  version     INTEGER,               -- the row's NEW per-row version after this mutation
  updatedAt   TEXT,                  -- UTC datetime string (the row's new updatedAt)
  ownerId     TEXT,                  -- denormalized so pull can filter without a join
  visibility  TEXT                   -- denormalized ("private" | "shared"), same reason
)
```

Denormalizing `ownerId` + `visibility` onto the feed entry is deliberate: the pull filter (below) is then a pure `WHERE` on one table, no join to the entity table. A feed entry is written for **every** committed mutation — including soft-deletes (so a tombstone reaches every device) and visibility flips (so a device can learn an item became invisible to it).

### 3.2 Pull semantics

`GET /sync/pull?cursor=<seq>&limit=<n>`

1. `cursor` is the client's last-seen global `seq` (`0` = nothing seen yet).
2. Server selects `SELECT * FROM change_feed WHERE seq > :cursor ORDER BY seq ASC LIMIT :limit`.
3. For each selected entry, the server **hydrates** the current entity row (so the client gets the *latest* state, not an intermediate state if the same row changed twice within the window).
4. The server **filters by visibility**: keep an entry iff `ownerId == me` **or** `visibility == "shared"`. (A spouse's `private` item never leaves the server.)
5. Response returns `entries` (the feed delta) + `items` (hydrated entities) + `nextCursor` + `hasMore`. The client loops until `hasMore = false`.

**Pagination/batching:** `limit` defaults to `500`, capped at `1000`. The client pages in a loop. Batching is bounded by D1 row limits and Worker memory; 500 is comfortably safe. `nextCursor` is the max `seq` actually returned (not `cursor + limit`), so a client can stop mid-page and resume exactly.

**Initial bootstrap:** when `cursor` is absent/`0` on a fresh install (or a cleared mirror), a full pull is a *lot* of rows plus the non-syncable context (`User`, `Household`, `Membership`, `Tag` — these are *not* common items and have no `version`/feed entry per domain-model §3.1). So bootstrap is a **separate endpoint** (see §3.3), and `/sync/pull` stays purely incremental.

**Cursor too old (`resetRequired`):** the feed is retained for a window (see **DP-8**). If the client's `cursor` predates the retained window, the server responds `resetRequired: true` instead of a delta, and the client re-bootstraps. This is the safety net that lets us bound feed growth.

### 3.3 Bootstrap — `GET /sync/bootstrap`

Returns, paged:
- `context`: the current `User`, `Household`, `Membership`s, and the household `Tag` set (fetched whole, rarely change).
- `items`: **all** visible common items (every `shared` + own-`private` live row), paged like pull.
- `cursor`: the current max `seq`, so the client starts incremental pulls from "now".

---

## 4. Outbox push — `POST /sync/push`

### 4.1 The outbox entry (what the client queues offline)

Every local mutation appends **one** outbox entry, written to IndexedDB in the **same transaction** as the mirror write (`writeLocal()` — the map's CC-02 "outbox queue via `writeLocal()` in one transaction").

```ts
// one queued mutation
{
  clientMutationId: string,   // UUID v7 — the idempotency key
  entityType: ItemType,
  entityId: string,           // UUID v7
  baseVersion: number,        // the row's version this client LAST saw (0 = insert)
  op: "upsert" | "delete",
  patch: Record<string, unknown>,   // changed fields only (partial) — see DP-3
  clientUpdatedAt: string     // UTC datetime of the client edit (LWW input)
}
```

- `baseVersion` is the **optimistic concurrency** anchor. When a client edits a row it recorded `baseVersion = <version it last saw>`. The next edit to *the same row* from the same client chains off the version the server assigned to the previous edit — so per-entity causal order is preserved (see §4.3). Until that response arrives the client has not seen a newer server version, so a second edit queued against the same row stores the **same** anchor; the push engine substitutes the version returned for the preceding entry of that entity when it sends the chain.
- `patch` is **partial** (only fields the user actually changed), which is what makes field-level LWW possible (two users editing *different* fields of one row don't clobber each other).

### 4.2 Server apply (idempotent + atomic on D1)

`POST /sync/push` carries up to `N` entries (chunked by the client; server cap ~`200`/request). The server, per request:

1. **Dedupe (idempotency).** Pre-read `applied_mutations` for the batch's `clientMutationId`s. Any already applied → reuse the stored result, **skip** (this is exactly-once replay after a lost response).
2. **Apply the remaining entries as one `D1Client.batch()`.** For each *new* entry the batch carries:
   - `INSERT OR IGNORE INTO applied_mutations (clientMutationId, entityType, entityId, serverVersion) VALUES (...)`
   - the entity **upsert** with `version = version + 1` guarded by `WHERE id = :id AND version = :baseVersion` (compare-and-set — see conflict path §6),
   - `INSERT INTO change_feed (...)` with the new `version`/`updatedAt`/`op`/`ownerId`/`visibility`.

   Writes are ordered **parents before children** (projects/tags/lists before tasks/notes/listItems), so an offline create of a parent and its dependent row in the same push applies in that one batch.
3. The batch is **atomic** — all-or-nothing (D1 rolls back the batch on any failure). If it fails on a SQLite constraint (UNIQUE / FOREIGN KEY / CHECK / NOT NULL), the server attributes it by **bounded recursive bisection**: the ordered groups are split in half and each half is retried as its own batch; a half that succeeds is applied once, a half that still fails is split again, and a single group is attempted once. An entry that can never apply as written comes back as `{ _tag: "rejected", code, message }` while the rest of the push still applies. A push issues at most `MAX_ISOLATION_BATCHES` (32) batches in total including the first attempt — enough for one bad entry (~18) or two (~31) among the 200-entry push cap. If that cap is reached, the unattempted remainder is returned as `rejected` with code `AttributionLimit` so the client acks it instead of resending the chunk forever (a bounded, explicit loss rather than an O(entries) fan-out that trips D1/Workers limits). An **upsert** insert silently suppressed by `ON CONFLICT DO NOTHING` (a live unique tag name) is treated the same way, instead of becoming an endless retryable contention. (A *delete* tombstone insert that no-ops is not a rejection: it means the row appeared after the pre-read, and the retry resolves it through the CAS.) Each successful entry still commits its entity row, feed row and ledger row together, so a replay dedupes and nothing is applied twice. Non-constraint failures are not isolated: they keep the retryable 500 behaviour.

**Why this is sound on D1:** D1 is *single-writer* per database — concurrent pushes from the two users are serialized by D1 itself, so the `version = :baseVersion` compare-and-set and the `applied_mutations` dedupe cannot both "win" a race in the two-user case. (The one theoretical race — the *same* `clientMutationId` pushed twice *concurrently* — is excluded because the client awaits each push and never fires the same id concurrently. This is the documented MVP boundary.)

**`applied_mutations` retention** mirrors the change-feed window (see DP-8): purge applied-mutations rows once the client can no longer possibly replay that id (after the feed window has passed).

### 4.3 Ordering: outbox vs server monotonic versions

- The client's outbox is a **FIFO with per-entity causal order**: for a given `entityId`, entries must be sent and applied in the order created (each `baseVersion` references the previous entry's assigned `version`). Entries for *different* entities are independent and may be interleaved arbitrarily. The queued `baseVersion` is authoritative only for the **first un-acked entry per entity**; the engine replaces the anchor of every subsequent entry with the `version` from the preceding push result before sending it.
- The server assigns `seq` and `version` in **arrival order** — the server's ordering is authoritative. The client's local optimistic values are **discarded** on ack; the client adopts the server's returned `version` and advances its cursor to the returned `seq`.
- The push **response** returns, per entry, `{ _tag: "applied", entityId, version, seq }` (or `"alreadyApplied"` / `"conflict"` / `"tombstone"` / `"rejected"`). A `"rejected"` result carries a stable `code` and a diagnostic `message`, and no `version`/`seq`: the entry cannot apply as written (invalid patch, duplicate live tag name, missing FK parent), so the client acks and drops it rather than retrying forever. Because the response carries the authoritative `seq`, the client can advance its pull cursor past its own writes without a second round-trip.

---

## 5. Realtime wake-up — SSE per household vs cursor-wake polling

The map settled **"SSE channel per household; clients pull whenever a wake-up (or reconnect) occurs."** So SSE is a **wake signal, not a data channel** — the client always `pull`s for data. The wake payload is tiny:

```ts
{ _tag: "wake", householdId: string, seq: number }  // client pulls from its own cursor
```

Two distinct questions are bundled here and should be decided separately (see **DP-5**, **DP-6**):

1. **What carries the wake — SSE or polling?** SSE is the settled intent; the wrinkle is that D1 has no pub/sub and Cloudflare Workers isolates don't share memory, so an SSE fan-out needs a **per-household Durable Object** (new infra not yet in the settled stack) to hold open connections across isolates — or a **cursor-wake poll** (client polls `/sync/pull?cursor` every 2–4s, zero new infra). A 2–4s poll still meets the acceptance bar "change visible to the other user within a few seconds".
2. **Does the wake carry data, or just a nudge?** Recommend **nudge-only** (a single `seq`): one data path (pull) means one ordering, one dedupe, one conflict code path. Inline data in the SSE stream would duplicate the pull path and its conflict handling.

---

## 6. Conflict rules (settled precedence, run server-side)

Conflicts only happen when a push's `baseVersion` is **behind** the row's current `version` (two devices/people wrote concurrently, or offline-edit vs remote-edit). The server is the **single resolver** (see DP-2); rules apply in this precedence order:

1. **Tombstone wins** (settled). If the stored row is soft-deleted (`deletedAt` set), a non-delete push **does not resurrect** it. The server returns `{ _tag: "tombstone" }`; the client surfaces "this item was deleted elsewhere" and may offer to re-create as a **new** entity (fresh UUID v7). *(This is the settled answer to map decision #8's sub-question: delete beats a concurrent offline edit; nothing resurrects.)*
2. **Delete-with-recovery** (CC-03, settled). If the *incoming* push is a delete but the stored row was *edited* since `baseVersion`, the **delete wins** (row goes to trash), and because it's soft-delete the edit is recoverable. A delete is never silently lost to a concurrent edit.
3. **Checklist done-wins** (settled). For `ListItem.done` (and analogously `Task.status` when a completion is involved): if either side has `done = true` (or `status = "done"`), the merged result is `done = true`. "I checked it off" beats "I renamed it".
4. **Recurrence single-writer** (settled). `recurrence` (events/tasks) is only ever written by the **owner**; there are no concurrent *cross-user* recurrence edits to merge. Two devices of the *same* owner serialize cleanly via `baseVersion` chaining, so a stale recurrence push is simply rejected (tell the user to refresh) rather than merged.
5. **Field-level LWW** for everything else. The client's `patch` lists only the fields it changed. On conflict, merge field-by-field:
   - fields **not** in the patch → keep the server's value;
   - fields **in** the patch → compare `patch.clientUpdatedAt` against the row's `updatedAt`; the newer wins.
   - This is "field-level LWW" using the single row-level `updatedAt` as the recency proxy — two users editing *different* fields never clobber, and same-field races resolve by recency (see **DP-3** for the granularity tradeoff).

When the server resolves a conflict, it writes the **merged** row with a bumped `version` (so the merge itself syncs to the other device), appends a feed entry, and returns the authoritative merged row in the push result so the client adopts it immediately.

---

## 7. Client hydration order (offline-first)

The map (CC-02) fixes the shape — "IndexedDB mirror populated first; server then reconciles." The concrete sequence, executed on load and on reconnect:

1. **Open the IndexedDB mirror** — the UI renders from local state *immediately*, never waiting on the network. Stores: `mirror` (entity rows keyed by `entityId`), `outbox` (pending mutations), `meta` (`lastCursor`, per-entity `baseVersion`).
2. **Replay the outbox into the mirror** — apply the client's own un-acked local writes so the screen shows the user's intent (optimistic state) before any server contact.
3. **Server reconcile: pull → push.** First `pull` (bring the server's committed changes down and resolve them against local state), then `push` the outbox (send the client's changes up). Pull-first means the client resolves against the *latest* server state before pushing, which minimizes conflicts.
4. **Adopt authoritative results.** The push response carries the server's authoritative `version`/`seq` and any merged rows; the client overwrites its optimistic values with these, advances `lastCursor`, and drops the acked outbox entries.
5. **Wake-driven re-pull.** On any SSE wake (or the poll interval, if polling), repeat step 3's pull. The mirror stays warm; the network only ever moves deltas.

The IndexedDB mirror is the *source for rendering*; the server is the *source of truth*. The client never trusts its own `version`s after an ack.

---

## 8. Wire shapes (Effect Schema v4 code sketches)

These are the **shared codecs** — they live in `packages/domain`, `api` validates with them, `web` parses with them. Transport is plain HTTP JSON; no RPC.

```ts
import { Schema } from "effect"
import { ItemType, Visibility, UserId, HouseholdId } from "@tali/domain" // from ticket #7

// ── One committed change in the household feed ──────────────────────────
export const SyncOp = Schema.Literal("upsert", "delete")

export const ChangeFeedEntry = Schema.Struct({
  seq: Schema.Int,                     // global monotonic pull cursor
  entityType: ItemType,                // discriminator
  entityId: Schema.String,             // UUID v7 (branded id validated at hydration)
  op: SyncOp,                          // "delete" = soft-delete tombstone
  version: Schema.Int,                 // row's NEW per-row version after this mutation
  updatedAt: Schema.DateTimeUtcFromString,
  ownerId: UserId,                     // denormalized: enables pull filter w/o join
  visibility: Visibility               // denormalized: same reason
})

// ── Pull ────────────────────────────────────────────────────────────────
export const SyncPullRequest = Schema.Struct({
  cursor: Schema.Int,                  // last-seen seq (0 = none)
  limit: Schema.Int                    // 1..1000 (server default 500)
})

export const SyncPullResponse = Schema.Struct({
  entries: Schema.Array(ChangeFeedEntry),   // the delta
  items: Schema.Array(SyncEntity),          // hydrated latest rows (see below)
  nextCursor: Schema.Int,                   // max seq returned (resumable)
  hasMore: Schema.Boolean,
  resetRequired: Schema.Boolean             // true → cursor too old, re-bootstrap
})

// ── Bootstrap (fresh install / cleared mirror / resetRequired) ──────────
export const SyncBootstrapResponse = Schema.Struct({
  user: User.json,
  household: Household.json,
  memberships: Schema.Array(Membership.json),
  tags: Schema.Array(Tag.json),             // household-scoped tag set
  items: Schema.Array(SyncEntity),          // ALL visible items, paged
  cursor: Schema.Int
})

// ── Push ────────────────────────────────────────────────────────────────
export const SyncPushEntry = Schema.Struct({
  clientMutationId: Schema.String,     // UUID v7 — idempotency key
  entityType: ItemType,
  entityId: Schema.String,
  baseVersion: Schema.Int,             // version this client last saw (0 = insert)
  op: SyncOp,
  patch: Schema.Record({ key: Schema.String, value: Schema.Unknown }), // changed fields only
  clientUpdatedAt: Schema.DateTimeUtcFromString
})

export const SyncPushRequest = Schema.Struct({
  entries: Schema.Array(SyncPushEntry)      // chunked; server cap ~200/request
})

export const SyncPushResult = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("applied"), entityId: Schema.String, version: Schema.Int, seq: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("alreadyApplied"), entityId: Schema.String, version: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("conflict"), entityId: Schema.String, version: Schema.Int, merged: SyncEntity }),
  Schema.Struct({ _tag: Schema.Literal("tombstone"), entityId: Schema.String, version: Schema.Int }),
  // Non-retryable: this one entry cannot apply as written; the client drops it.
  Schema.Struct({
    _tag: Schema.Literal("rejected"),
    entityId: Schema.String,
    code: Schema.String,      // e.g. "InvalidPatch" | "UniqueViolation" | "ForeignKeyViolation"
    message: Schema.String
  })
)

export const SyncPushResponse = Schema.Struct({
  results: Schema.Array(SyncPushResult),
  cursor: Schema.Int                    // highest seq this push wrote; client may advance past it
})

// ── Realtime wake (SSE body / poll "changed?" reply) ────────────────────
export const SyncWakeEvent = Schema.Struct({
  _tag: Schema.Literal("wake"),
  householdId: HouseholdId,
  seq: Schema.Int                       // latest feed seq; client pulls from its own cursor
})
```

### The hydrated entity — `SyncEntity`

The single payload codec for "one syncable item in its latest state", discriminated by `type`. Because the domain model currently types `type` as the full `ItemType` union (not a narrowed literal), sync needs each entity's `type` **narrowed** to its literal so the union can discriminate:

```ts
// Example for two of the eleven types — repeat for the rest
// (habitEntry, event, occasion, reminder, note, tag, list, listItem, project).
export const SyncEntity = Schema.Union(
  Schema.Struct({ ...Habit.json.fields, type: Schema.Literal("habit") }),
  Schema.Struct({ ...Task.json.fields, type: Schema.Literal("task") }),
  Schema.Struct({ ...ListItem.json.fields, type: Schema.Literal("listItem") })
  // ...
)
```

> **Small follow-up to fold into `packages/domain`** (not a re-litigation of #7): declare each entity's `type` as its literal (`Schema.Literal("habit")`) rather than the full `ItemType`, so the sync codec and the domain model share one discriminator. Everything else from #7 stands.

*(Note: Effect v4 has no top-level `Schema.UUID` const — it has `Schema.isUUID(version)` as a filter and `Model.UuidV7Insert` for model ids. The wire envelopes above therefore use `Schema.String` for ids, and branded-id validation happens when the client hydrates an entity against the per-entity `Model` schema. `Schema.Union` takes an array of members; `Schema.TaggedUnion(tag, cases)` is available if we prefer a discriminated-union helper.)*

---

## 9. Open decision points (HITL — the humans settle these)

Each is a crisp question with a recommendation. **These are the real decisions this draft surfaces.**

- **DP-1 — Pull granularity: a `change_feed` table (global `seq`) vs per-row `version` with per-entity cursors?**
  *Recommendation:* **`change_feed` table (global `seq`) as the pull list, keep per-row `version` as the conflict field.** One scalar cursor across all 11 entity types; SSE wake can name a single `seq`; visibility flips and tombstones become explicit feed entries; the feature map §7 already says push "appends a change-feed entry". The per-row-version alternative (11 per-entity cursors, no feed table) is simpler schema-wise but pushes real complexity into the client and cannot express "you can no longer see this item". *Sub-question:* is the denormalized `ownerId`/`visibility` on the feed worth the extra write? (Recommend yes — the pull filter becomes a single-table `WHERE`.)

- **DP-2 — Where do conflicts resolve: server-side at push time, or client-side at pull time?**
  *Recommendation:* **server-side, at push time, server is the single resolver.** The push response returns authoritative merged rows so the client adopts truth immediately and every device converges on the same bytes. Client-side resolution (pull a "both versions" conflict and let the client merge) spreads the rules across web clients and risks two clients merging differently. The client still does its own *optimistic* merge for outbox replay, but the server's merge is final.

- **DP-3 — "Field-level LWW" granularity: partial `patch` vs whole-row write?**
  *Recommendation:* **partial `patch` (only changed fields), LWW by `updatedAt` on the touched fields.** This is what makes two users editing *different* fields of one row (e.g. one renames a shared list item, the other toggles it) merge cleanly instead of clobbering. Whole-row LWW is simpler but loses that. Trade the cost: the patch must list its changed fields, and LWW recency uses the single row-level `updatedAt` as the proxy (no per-field timestamps).

- **DP-4 — Exactly-once apply: `applied_mutations` dedup table, `version` compare-and-set, or both?**
  *Recommendation:* **both.** `clientMutationId` + an `applied_mutations` table gives idempotent replay after a lost response (skip, return the stored result). The `version = baseVersion` compare-and-set on the upsert guards against the rare double-fire and doubles as conflict detection. Dedup-table-only is vulnerable to the upsert running twice in a race; CAS-only can't return "already applied" to a retried request.

- **DP-5 — Realtime wake-up: SSE per household (needs a Durable Object) vs cursor-wake polling?**
  *Recommendation:* **cursor-wake polling (2–4s) for the MVP; add SSE-on-a-per-household-Durable-Object in hardening.** Polling is zero new infra, meets the "within a few seconds" acceptance bar, and keeps one data path (pull). SSE is the settled *intent*, but its fan-out requires a Durable Object (new infrastructure not yet in the settled stack) because Workers isolates don't share memory and D1 has no pub/sub. If the humans want true push now, the DO is the correct primitive — decide the infra cost explicitly.

- **DP-6 — Does the wake channel carry data, or just a nudge?**
  *Recommendation:* **nudge-only** (`{ _tag: "wake", seq }`); data always flows through `/sync/pull`. One data path means one ordering, one dedupe, one conflict resolver. Inlining data in the SSE stream duplicates the pull path and its conflict handling for no gain at two-user scale.

- **DP-7 — How do the client's optimistic versions relate to the server's `seq`?**
  *Recommendation:* **server-assigned `seq`/`version` are authoritative; the client discards optimistic values on ack and adopts the returned ones.** The outbox only preserves **per-entity** causal order (via `baseVersion` chaining); cross-entity order is the server's to define at apply time. The push response returns the highest `seq` it wrote so the client can advance its cursor past its own writes without an extra pull.

- **DP-8 — Tombstone & change-feed retention: bounded window + `resetRequired` vs unbounded?**
  *Recommendation:* **bounded.** Keep `change_feed` (and `applied_mutations`) for **90 days**, then purge; a client whose cursor predates the window gets `resetRequired: true` and re-bootstraps (safe — soft-deleted rows are still queryable until their 30-day trash purge, and truly-purged rows are gone by the settled purge semantics anyway). Unbounded feed growth is a slow D1 size/perf tax for a 2-user household. The 30-day tombstone purge stays as settled; only the *feed* retention window is new.

- **DP-9 — Sync scope: household-scoped feed + per-client visibility filter vs per-user feed?**
  *Recommendation:* **household-scoped `change_feed`, filtered per client** (`ownerId == me OR visibility == shared`). One feed per household, one `seq` namespace, and the pull filter is a single-table `WHERE`. The per-user-feed alternative (write each change to each member's feed) duplicates writes and complicates visibility flips. *Consequence to accept:* when a spouse flips a shared item to `private`, the *other* client must learn it can no longer see the row — which the denormalized `visibility` on the feed entry expresses as "remove from mirror". This is the one non-obvious case the filter must handle.

---

## 10. What this draft deliberately does *not* decide

- The **typed error hierarchy** for sync (`SyncConflict`, `SyncStaleCursor`, …) — deferred to the error-model ticket (map §"Not yet specified"); this draft only names the result `_tag`s on the happy/conflict paths.
- The **D1 batch size limit** for push chunks (exact statement count / byte budget) — an implementation detail to measure in Slice 1, not a decision.
- **SSE fan-out internals** (Durable Object vs `WebSocket` hibernation vs polling) — folded into DP-5/DP-6 as the decision, with implementation deferred.
- **Encryption/at-rest** of the mirror — out of scope; the mirror holds no more than the server already holds.
