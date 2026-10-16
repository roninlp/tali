# Tali — Domain Model & Shared Schema (Draft)

> **Status:** PROTOTYPE — rough take for the owner + developer to react to. Not a final contract.
> **Ticket:** [#7](https://github.com/roninlp/tali/issues/7) (HITL prototype)
> **Source authority:** `docs/must-have-feature-map.html` §5/§7, `docs/product-requirements-v2.html` §22 (واژه‌نامه / data conventions), research findings in `docs/research/`.
> **Effect version:** v4.0.5 (vendored at `repos/effect`). Schema/Model APIs live under `effect/Schema` and `effect/schema` (v4 naming), *not* the old `@effect/schema` 3.x import paths.

---

## 1. Guiding constraints (already settled — do not re-litigate)

1. **Shared package** `packages/domain` is the single home for every schema, ID, enum, and invariant. `packages/rpc` and `packages/sql` consume it; web and api both depend on it.
2. **Effect v4** is the type system: `Schema` (from `effect`), `Model` (from `effect/schema`), `SqlSchema`/`SqlModel` (from `effect/sql`), `Data` for typed errors.
3. **Database** is D1 (SQLite) via `@effect/sql-d1`. No interactive transactions — atomic multi-statement via `D1Client.batch()`. Migrations via `drizzle-kit` (d1-http) or `wrangler`.
4. **Time:** instants stored as `timestamptz`-equivalent (a UTC datetime string), all-day dates stored as a local `date` + an IANA `timeZone`. Temporal `persian` calendar is the only date-math engine.
5. **Sync:** every syncable row carries a monotonic `version` (server-assigned) + `updatedAt`, plus a `deletedAt` for soft delete. Cursor pulls by version.
6. **Auth:** two known users, one `Household`, two `Membership`s. argon2 + HTTP-only session cookies.

---

## 2. Shared building blocks

### 2.1 Imports (verified against vendored source)

```ts
import { Data, Schema } from "effect"      // Schema, Data.*
import { Model } from "effect/schema"      // Model.Class, Model.GeneratedByDb, Model.DateTime*, Model.UuidV7Insert
```

### 2.2 Branded ID types

IDs are **UUID v7** strings (time-ordered, client-generated — see open decision #1). Each aggregate gets a nominal type so the compiler forbids cross-assignment:

```ts
export const UserId       = Schema.String.pipe(Schema.brand("UserId"))
export const HouseholdId  = Schema.String.pipe(Schema.brand("HouseholdId"))
export const MembershipId = Schema.String.pipe(Schema.brand("MembershipId"))
export const HabitId      = Schema.String.pipe(Schema.brand("HabitId"))
export const HabitEntryId = Schema.String.pipe(Schema.brand("HabitEntryId"))
export const EventId      = Schema.String.pipe(Schema.brand("EventId"))
export const OccasionId   = Schema.String.pipe(Schema.brand("OccasionId"))
export const TaskId       = Schema.String.pipe(Schema.brand("TaskId"))
export const ReminderId   = Schema.String.pipe(Schema.brand("ReminderId"))
export const NoteId       = Schema.String.pipe(Schema.brand("NoteId"))
export const TagId        = Schema.String.pipe(Schema.brand("TagId"))
export const ListId       = Schema.String.pipe(Schema.brand("ListId"))
export const ListItemId   = Schema.String.pipe(Schema.brand("ListItemId"))
export const ProjectId    = Schema.String.pipe(Schema.brand("ProjectId"))
export const SubscriptionId = Schema.String.pipe(Schema.brand("SubscriptionId"))
```

### 2.3 Enums

```ts
export const Visibility  = Schema.Literal("private", "shared")      // two-user household: no finer ACL needed
export const TaskStatus  = Schema.Literal("todo", "doing", "done")
export const Priority    = Schema.Literal("high", "medium", "low")
export const HabitEntryStatus = Schema.Literal("done", "partial", "missed")
export const ReminderType     = Schema.Literal("medication", "exercise", "chore", "general")
export const ReminderTier     = Schema.Literal("normal", "critical") // "critical" = medication; bypasses quiet hours unless explicitly silenced
export const ListItemSort     = Schema.Literal("manual", "alpha", "status")
export const NoteLifecycle    = Schema.Literal("active", "archived", "trashed") // derived from flags in practice
```

### 2.4 The "common item" shape

Every syncable, user-facing entity shares the same field set so **sync, trash, and (later) search work uniformly** (feature map §7; PRD §22.1). This is encoded as a reusable field map, not a base class (Effect Schema favors composition over inheritance).

| Field | Type | Notes |
|---|---|---|
| `id` | branded UUID v7 string | client-generated (offline-first) |
| `type` | `ItemType` | discriminator for cross-entity sync/trash payloads |
| `title` | `string` | required everywhere except ListItem (items have a `name`) |
| `ownerId` | `UserId` | the author; not the same as `visibility` |
| `visibility` | `Visibility` | `private` (owner only) or `shared` (both household members) |
| `status` | *per-entity enum* | Task → `TaskStatus`; ListItem → done flag; Note → lifecycle; HabitEntry → its own status. This is the one common field whose *type* is entity-specific. |
| `tags` | `TagId[]` (denormalized) + join table | see open decision #3 |
| `color` | `string \| null` | CSS color / accent token |
| `createdAt` | UTC datetime string | set on insert |
| `updatedAt` | UTC datetime string | set on every commit |
| `version` | `int` | **server-monotonic** per-row counter; bumped on every committed mutation (including delete) |
| `deletedAt` | UTC datetime \| null | soft delete; `null` = live |

```ts
export const ItemType = Schema.Literal(
  "habit", "habitEntry", "event", "occasion", "task", "reminder",
  "note", "tag", "list", "listItem", "project"
)

// Reusable map; merged into each entity's Model.Class.
const commonItemFields = {
  id: /* per-entity branded id */,
  type: ItemType,
  title: Schema.String,
  ownerId: UserId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate.pipe(Schema.withDefault(() => null))),
}
```

> **Deliberate choice:** `version` is a server-assigned integer, not a client clock. The client writes to an outbox with a `clientMutationId` (UUID) for idempotent replay; the server assigns the authoritative `version` on commit and returns it. Pull ordering is by `(version, updatedAt)`. Field-level LWW resolves concurrent edits; checklist "done" wins (settled in feature map §7).

### 2.5 Time & timezone conventions (settled in `temporal-jalali.md`)

- **Instant** (`Event.start`, `Reminder.fireAt`, audit timestamps) → stored as a UTC datetime string (`Schema.DateTimeUtcFromString`). Rendering into Jalali/Gregorian is a projection at read/display time using the owner's IANA `timeZone`.
- **All-day / local date** (`HabitEntry.date`, `Event.allDayDate`, `Occasion.monthDay`) → stored as a **local date string** (`Schema.DateFromString`, ISO `YYYY-MM-DD` **without** timezone) + an explicit IANA `timeZone` so "today" means the right thing when the device roams. Defaults to the owner's profile timezone but is stored per-item.
- **Jalali is never persisted.** Internally everything is ISO/Gregorian; Jalali is a display + input concern handled by Temporal's `persian` calendar. This is why no entity carries a `calendar` field.

---

## 3. Aggregates

### 3.1 `User`, `Household`, `Membership` (auth & shared space)

These are **not** "common items" (no `version`/`tags`/`deletedAt` sync contract — they change rarely and are fetched whole).

```ts
export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,                    // normalized lower-case
  passwordHash: Model.Sensitive(Schema.String),  // argon2id; never serialized to JSON
  displayName: Schema.String,
  timeZone: Schema.String,                 // IANA, e.g. "Asia/Tehran"; captured once at signup
  weekStart: Schema.Literal("saturday", "sunday", "monday"),  // default "saturday"
  digits: Schema.Literal("persian", "latin"),                 // default "persian"
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate
}) {}

export class Household extends Model.Class<Household>("Household")({
  id: Model.UuidV7Insert(HouseholdId),
  name: Schema.String,
  createdBy: UserId,
  createdAt: Model.DateTimeInsertFromDate
}) {}

export const MembershipRole = Schema.Literal("owner", "member")

export class Membership extends Model.Class<Membership>("Membership")({
  id: Model.UuidV7Insert(MembershipId),
  householdId: HouseholdId,
  userId: UserId,
  role: MembershipRole,                    // first user = "owner"
  joinedAt: Model.DateTimeInsertFromDate
}) {}
```

### 3.2 `Habit` + `HabitEntry`

```ts
export const HabitFrequency = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("daily") }),
  Schema.Struct({ _tag: Schema.Literal("weekdays"), days: Schema.Array(Schema.Int) }), // ISO 1..7
  Schema.Struct({ _tag: Schema.Literal("weekly"), times: Schema.Int })                 // "X times / week"
)

export class Habit extends Model.Class<Habit>("Habit")({
  id: Model.UuidV7Insert(HabitId),
  type: ItemType,                          // "habit"
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  ownerId: UserId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  frequency: HabitFrequency,
  // Frequency history — changing frequency must NOT rewrite past stats (FR-HAB-03 edge case):
  // stored as a list of { effectiveFrom: date, frequency: HabitFrequency }.
  frequencyHistory: Schema.Array(Schema.Struct({
    effectiveFrom: Schema.DateFromString,
    frequency: HabitFrequency
  })),
  reminderTime: Schema.NullOr(Schema.String), // local "HH:mm", optional
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}

// HabitEntry is a SEPARATE table (open decision #2). Idempotent upsert keyed by (habitId, localDate).
export class HabitEntry extends Model.Class<HabitEntry>("HabitEntry")({
  id: Model.UuidV7Insert(HabitEntryId),
  habitId: HabitId,
  ownerId: UserId,                         // denormalized for per-user filtering
  date: Schema.DateFromString,             // local date (owner's timezone); backdating window ≤ 7 days
  timeZone: Schema.String,                 // IANA, so "date" is unambiguous
  status: HabitEntryStatus,
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}
```

> `HabitEntry` is the one entity that also needs a **unique** `(habitId, date)` — modeled as a D1 `UNIQUE` index, not a schema invariant (schemas validate shape, not cross-row uniqueness).

### 3.3 `Event` (+ occurrence exceptions)

```ts
export const RecurrenceFrequency = Schema.Literal("daily", "weekly", "monthly", "yearly")

export const RecurrenceEnd = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("never") }),
  Schema.Struct({ _tag: Schema.Literal("count"), count: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("until"), until: Schema.DateFromString })
)

// Structured union (open decision #4), NOT an RRULE string.
export const RecurrenceRule = Schema.Struct({
  frequency: RecurrenceFrequency,
  interval: Schema.Int,                                   // every N days/weeks/months/years
  byDay: Schema.optional(Schema.Array(Schema.Int)),       // ISO weekday numbers 1..7
  byMonthDay: Schema.optional(Schema.Array(Schema.Int)),
  nthWeekday: Schema.optional(Schema.Struct({ nth: Schema.Int, day: Schema.Int })), // "last Friday"
  end: RecurrenceEnd
})

export class Event extends Model.Class<Event>("Event")({
  id: Model.UuidV7Insert(EventId),
  type: ItemType,                          // "event"
  title: Schema.String,
  ownerId: UserId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  // Time: EITHER timed (start/end instants) OR all-day (local date + tz). A discriminated union.
  timing: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("timed"),
      start: Schema.DateTimeUtcFromString,
      end: Schema.DateTimeUtcFromString     // may be null for zero-duration? kept required for simplicity
    }),
    Schema.Struct({
      _tag: Schema.Literal("allDay"),
      date: Schema.DateFromString,
      timeZone: Schema.String
    })
  ),
  location: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.Json),        // description / structured content
  recurrence: Schema.NullOr(RecurrenceRule),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}

// Occurrence exceptions: "this occurrence only" / "this and following" edits & deletions.
export const ExceptionAction = Schema.Literal("delete", "override")

export class EventException extends Model.Class<EventException>("EventException")({
  id: Model.UuidV7Insert(Schema.String.pipe(Schema.brand("EventExceptionId"))),
  eventId: EventId,
  instanceId: Schema.String,               // stable occurrence key (e.g. the original start instant / ISO date)
  action: ExceptionAction,
  overrides: Schema.NullOr(Schema.Struct({  // only when action = "override"
    title: Schema.optional(Schema.String),
    timing: Schema.optional(/* same union as Event.timing */ Schema.Json),
    color: Schema.optional(Schema.NullOr(Schema.String))
  })),
  createdAt: Model.DateTimeInsertFromDate,
  version: Schema.Int
}) {}
```

> **Edit-scope note:** "this and following" is represented by a `RecurrenceRule.end = until(instanceDate - 1)` on the original plus an exception row (or a new event) — the exact split is an engine detail flagged in open decision #6.

### 3.4 `Occasion` (annual important dates)

```ts
export class Occasion extends Model.Class<Occasion>("Occasion")({
  id: Model.UuidV7Insert(OccasionId),
  type: ItemType,                          // "occasion"
  title: Schema.String,
  ownerId: UserId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  monthDay: Schema.Struct({ month: Schema.Int, day: Schema.Int }), // e.g. a birthday; day 30 handles Esfand leap
  timeZone: Schema.String,                 // for correct annual expansion when the user travels
  advanceReminderDays: Schema.Int,         // e.g. 7 → remind 7 days before
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}
```

### 3.5 `Task` (+ recurrence linkage)

```ts
export const TaskRecurrenceMode = Schema.Literal("onCompletion", "onDueDate")

export class Task extends Model.Class<Task>("Task")({
  id: Model.UuidV7Insert(TaskId),
  type: ItemType,                          // "task"
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  ownerId: UserId,
  visibility: Visibility,
  status: TaskStatus,
  priority: Priority,                      // default "medium"
  dueAt: Schema.NullOr(Schema.DateTimeUtcFromString),  // optional date, optional time-of-day
  dueDate: Schema.NullOr(Schema.DateFromString),        // denormalized local date for "today/upcoming" bucketing
  timeZone: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  tagIds: Schema.Array(TagId),             // denormalized; source of truth is the join table
  color: Schema.NullOr(Schema.String),
  recurrence: Schema.NullOr(RecurrenceRule),
  recurrenceMode: Schema.NullOr(TaskRecurrenceMode), // only meaningful when recurrence != null
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}
```

> Recurring tasks generate the **next instance** idempotently on completion/due (FR-TASK-04). The recurrence rule is shared with `Event` — one `RecurrenceService` drives both (feature map §7). `dueDate` + `timeZone` let the server bucket overdue/today/tomorrow/week without re-deriving the local date per request.

### 3.6 `Reminder` + `ReminderDispatch`

```ts
export const ReminderRepeat = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("once") }),
  Schema.Struct({ _tag: Schema.Literal("daily"), time: Schema.String }),        // local "HH:mm"
  Schema.Struct({ _tag: Schema.Literal("weekly"), days: Schema.Array(Schema.Int), time: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("interval"), hours: Schema.Int })        // "every 8 hours" (medication)
)

// Discriminated link (open decision #5), NOT nullable FKs.
export const ReminderLink = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("none") }),
  Schema.Struct({ _tag: Schema.Literal("habit"), habitId: HabitId }),
  Schema.Struct({ _tag: Schema.Literal("task"), taskId: TaskId }),
  Schema.Struct({ _tag: Schema.Literal("event"), eventId: EventId })
)

export class Reminder extends Model.Class<Reminder>("Reminder")({
  id: Model.UuidV7Insert(ReminderId),
  type: ItemType,                          // "reminder"
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  ownerId: UserId,
  visibility: Visibility,
  kind: ReminderType,
  tier: ReminderTier,                      // "critical" (medication) vs "normal"
  repeat: ReminderRepeat,
  fireAt: Schema.DateTimeUtcFromString,    // next fire instant
  link: ReminderLink,
  silencedUntil: Schema.NullOr(Schema.DateTimeUtcFromString), // snooze / "silence until"
  color: Schema.NullOr(Schema.String),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}

// Dispatch ledger + missed-reminder inbox (the closed-browser source of truth, research #4).
export const DispatchResponse = Schema.Literal("done", "snooze", "dismiss")

export class ReminderDispatch extends Model.Class<ReminderDispatch>("ReminderDispatch")({
  id: Model.UuidV7Insert(Schema.String.pipe(Schema.brand("ReminderDispatchId"))),
  reminderId: ReminderId,
  userId: UserId,                          // which member's device should receive it
  scheduledFor: Schema.DateTimeUtcFromString,
  deliveredAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  response: Schema.NullOr(DispatchResponse),
  respondedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  snoozedUntil: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Model.DateTimeInsertFromDate
}) {}
```

### 3.7 `Note` + `Tag`

```ts
export class Note extends Model.Class<Note>("Note")({
  id: Model.UuidV7Insert(NoteId),
  type: ItemType,                          // "note"
  title: Schema.String,
  body: Schema.NullOr(Schema.Json),        // TipTap/ProseMirror JSON (settled: structured content)
  plainText: Schema.String,                // extracted for FTS + snippets (Persian-normalized at write time)
  ownerId: UserId,
  visibility: Visibility,
  isPinned: Schema.Boolean,
  isArchived: Schema.Boolean,
  tagIds: Schema.Array(TagId),
  color: Schema.NullOr(Schema.String),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)  // trash; 30-day purge job
}) {}

export class Tag extends Model.Class<Tag>("Tag")({
  id: Model.UuidV7Insert(TagId),
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  ownerId: UserId,
  householdId: HouseholdId,                // tags are household-scoped so both users share a tag set
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate
}) {}
```

> **FTS note:** the note's `plainText` is normalized (نیم‌فاصله / همزه variants) on write so search hits a plain column. D1 FTS5 vs trigram is still an open item on the map (§"Not yet specified") and out of scope for *this* model.

### 3.8 `List` + `ListItem`

```ts
export class List extends Model.Class<List>("List")({
  id: Model.UuidV7Insert(ListId),
  type: ItemType,                          // "list"
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  ownerId: UserId,
  visibility: Visibility,                  // "shared" is the common case (live two-person)
  color: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  sort: ListItemSort,                      // default "manual"
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}

export class ListItem extends Model.Class<ListItem>("ListItem")({
  id: Model.UuidV7Insert(ListItemId),
  listId: ListId,
  name: Schema.String,                     // items use `name`, not `title`
  done: Schema.Boolean,
  order: Schema.Int,                       // manual ordering; reorder bumps the list's version
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  ownerId: UserId,                         // who created it (for "updated by spouse" label)
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,                     // per-item version (conflict: "done wins")
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}
```

> **Live sharing conflict rule (settled, feature map §7):** `done = true` wins over concurrent edits; other fields merge field-level LWW by `updatedAt`.

### 3.9 `Project`

```ts
export class Project extends Model.Class<Project>("Project")({
  id: Model.UuidV7Insert(ProjectId),
  type: ItemType,                          // "project"
  title: Schema.String,
  ownerId: UserId,
  visibility: Visibility,
  color: Schema.NullOr(Schema.String),
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
  version: Schema.Int,
  deletedAt: Schema.NullOr(Model.DateTimeUpdateFromDate)
}) {}
```

> `Project` groups `Task`s (via `Task.projectId`). The feature map §7 says it is "shared across tasks and lists where useful" — whether `List` also gets an optional `projectId` is left as a small open point (default: tasks only, keep lists flat).

---

## 4. Effect Schema v4 idioms (verified)

- **Model + variants:** `Model.Class<X>("X")({...})` derives `X.insert` / `X.update` / `X.json` / `X.jsonCreate` / `X.jsonUpdate` from one field declaration (`repos/effect/packages/effect/src/schema/Model.ts`).
- **Generated/audit fields:** `Model.GeneratedByDb`, `Model.DateTimeInsertFromDate`, `Model.DateTimeUpdateFromDate`, `Model.UuidV7Insert` (client/app-generated, time-ordered), `Model.Sensitive` (never JSON-encoded), `Model.BooleanSqlite`.
- **Nullable/optional:** `Schema.NullOr`, `Schema.optional`.
- **Discriminated unions:** `Schema.Union([Schema.Struct({ _tag: Schema.Literal("...") }), ...])`.
- **Typed errors:** `Schema.TaggedError` (see `repos/effect/packages/effect/src/sql/SqlError.ts` for the canonical pattern) — the typed error hierarchy itself is a *later* ticket ("Not yet specified" on the map), so this draft only sketches the data model, not the error model.

---

## 5. Open decision points (HITL — for the humans to settle)

Each is phrased as a crisp question with a recommendation. **These are the real decisions this draft surfaces.**

1. **ID format — UUID v7 vs cuid2 vs auto-increment?**
   *Recommendation:* **UUID v7** (client-generated, time-ordered). Offline-first means the client must mint IDs without the server; v7 is lexicographically sortable so it also gives B-tree locality on D1 and a natural tiebreak next to `version`. Auto-increment is disqualified (can't create offline). cuid2 is acceptable but unordered.

2. **`HabitEntry` as a separate table vs a `jsonb` log on `Habit`?**
   *Recommendation:* **separate table**, `UNIQUE(habitId, date)`. Streak/heatmap need range scans and an idempotent upsert keyed by local date; a jsonb blob would force read-rewrite of the whole habit on every tap and make 7/30/90-day window queries painful.

3. **How is `Tag` modeled — `string[]` on the item, a normalized `Tag` + join table, or both?**
   *Recommendation:* **both, with the join table as source of truth.** A first-class `Tag` entity (name + color, household-scoped) gives rename-propagate and tag filters; keep a denormalized `tagIds` array on each item so the sync payload and read models don't need a join. Flagging this because the feature map lists *both* `Tag`/`item_tags` tables (§7) and a common `tags` field.

4. **Event recurrence storage — RRULE string vs structured union?**
   *Recommendation:* **structured union** (the `RecurrenceRule` above). There is no RRULE lib in scope (settled: hand-rolled engine), Jalali recurrence needs `RSCALE` (RFC 7529) which string RRULE parsers don't handle, and "nth weekday" / "end by count or date" are cleaner as typed fields. Stored as a JSON column.

5. **How does `Reminder` link to Habit/Task/Event — nullable FK vs discriminated link union?**
   *Recommendation:* **discriminated union** (`ReminderLink`, stored as `linkType` + `linkId` columns or a small jsonb). Nullable FKs (`habitId?`, `taskId?`, `eventId?`) allow the invalid state "linked to two things at once"; the union forbids it and makes "Done → update linked habit/task" (FR-REM-03) a clean pattern-match.

6. **Occurrence exceptions & "this and following" edits — how to represent a series split?**
   *Recommendation:* represent "this and following" as: mutate the original `RecurrenceRule.end = until(lastKeptInstance)` + create a **new** `Event` for the remainder, with the edited occurrence as an `EventException(override)`. Avoids a separate "series ID" concept. *Open sub-question:* is the stable `instanceId` the occurrence's original start instant, or a deterministic hash of (rule + index)?

7. **Soft-delete vs hard-delete purge — when is data truly destroyed?**
   *Recommendation:* **soft delete (30 days in trash) then hard-delete purge**, with nightly D1 backup as the safety net. Matches CC-03 and PRD §22.1. *Open sub-question:* does `version` bump on delete (so deletes sync) — **yes**, delete is a committed mutation; `deletedAt` carries the tombstone.

8. **Per-row `version` vs household-global counter vs HLC for multi-device sync?**
   *Recommendation:* **per-row server-monotonic `version` + `updatedAt`** (as settled), with the client relying on a `clientMutationId` for idempotent replay. A household-global counter creates a hot spot on D1; HLC is overkill for two users. *Open sub-question:* does a client edit made while offline then pushed after a *delete* on the same row resurrect it? (Recommend: tombstone wins; surfaced as "item was deleted elsewhere".)

9. **Visibility — simple `private|shared` enum vs a per-member ACL table?**
   *Recommendation:* **simple enum.** Two known users in one household; every read is either owner-only or both. An ACL table is premature until a third member exists.

10. **Timezone for all-day items — stored per-item, or always inherited from owner's profile?**
    *Recommendation:* **stored per-item** (default = owner's profile tz at creation). A shared all-day event ("anniversary dinner") should not silently shift days when the *other* member views it in a different tz; but the *author's* intent day must survive. This is subtle — flagging explicitly.

11. **`Project` scope — tasks only, or also lists/notes?**
    *Recommendation:* **tasks only** for the MVP (feature map §7 wording implies tasks; lists stay flat). Adding `projectId` to `List` later is a non-breaking migration.

12. **`Event.end` — required or nullable (zero-duration / "point" events)?**
    *Recommendation:* **required** for simplicity; a zero-duration event is just `end == start`. Revisit if the calendar UX needs "untimed" reminders-as-events.

---

## 6. What this draft deliberately does *not* decide

- The **typed error hierarchy** (`HabitError`, `SyncError`, …) — a separate "Not yet specified" item on the map; the `Schema.TaggedError` shape is established here but not enumerated.
- **FTS backend** (FTS5 vs trigram) for Persian note search — noted as a placeholder on `Note.plainText`.
- **Reminder quiet-hours rules / medication tier rules / snooze semantics** — reminder *data* is modeled; the *scheduling policy* is a later ticket.
- **Streak/heatmap algorithm** (frequency-aware streak over 7/30/90) — `HabitEntry` + `frequencyHistory` give the algorithm what it needs; the algorithm is out of scope here.
- **Wire/HTTP contracts** for `/sync/pull`, `/sync/push`, SSE — this document defines the *entities* those endpoints move.
