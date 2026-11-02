# ADR-0011: Visibility is a per-aggregate policy, not a field every aggregate chooses

- **Status:** Accepted (2026-11-02)
- **Deciders:** Tali owner + developer (visibility-policy branch)
- **Related:** ADR-0006 (habit entries inherit the habit), `docs/domain-model-draft.md` §2.4 and open decision #9, `docs/sync-protocol-draft.md` DP-9

## Context

The first model gave every syncable aggregate the same common-item field map,
including a user-facing `visibility` (`private | shared`). That made two
claims at once:

- every aggregate can be private or shared, and
- `shared` is the sensible default unless the caller says otherwise.

Both are wrong. A session, a push subscription and a reminder dispatch are
owner-only rows: they must never be shared, and a user should not be offered a
choice that cannot be honoured. A project or a tag is household vocabulary:
both members see every row by definition. A habit entry and a list item are
children: their visibility belongs to the parent. Only lists, events, tasks,
notes, habits, reminders and occasions have a real privacy choice, and their
defaults differ (a note starts private; a list starts shared).

The old model also duplicated the default (`?? "shared"` in eight services,
`asVisibility` in the sync registry, `DEFAULT 'shared'` in SQL, a literal in
each client write helper). A client could send `visibility` on a project and
the server would store it; a non-owner could flip a shared task to private.

## Decision

### Four classes

Every aggregate belongs to exactly one class, declared in `VISIBILITY_POLICY`
(`packages/domain/src/visibility.ts`):

| Class | Meaning | Resolved value |
|---|---|---|
| `ownerOnly` | A single-member row. Never shared, no user control. | Always `private`. |
| `household` | Household-wide vocabulary. Always shared, no user control. | Always `shared`. |
| `inherited(parent)` | The parent row decides; the child never carries its own control. | The parent's value, at most narrower. |
| `shareable(default)` | The only class with a user-facing choice, with one default. | The user's choice, else the default. |

### Per-aggregate table

| Aggregate | Class | Default |
|---|---|---|
| `UserPreferences` | `ownerOnly` | `private` |
| `Session` | `ownerOnly` | `private` |
| `PushSubscription` | `ownerOnly` | `private` |
| `ReminderDispatch` | `ownerOnly` | `private` |
| `HabitEntry` | `inherited(habit)` | the habit's |
| `ListItem` | `inherited(list)` | the list's, may be narrower |
| `Project` | `household` | `shared` |
| `Tag` | `household` | `shared` |
| `List` | `shareable` | `shared` |
| `Event` | `shareable` | `shared` |
| `Task` | `shareable` | `shared` |
| `Note` | `shareable` | `private` |
| `Habit` | `shareable` | `private` |
| `Reminder` | `shareable` | `private` |
| `Occasion` | `shareable` | `private` |

`commonItemFields` no longer contains `visibility`. Each model still declares a
resolved `visibility` because `/sync/pull` filters on the stored column, but
the value is derived from the policy, never taken from an arbitrary payload.

### Write rules

- **Only create inputs for `shareable` aggregates accept `visibility`.** The
  project, tag, list-item and habit-entry create schemas do not have the field;
  a caller cannot ask for a value the policy owns.
- **Services resolve, never default.** `resolveCreateVisibility(aggregate, …)`
  is the one place that reads the policy default. `?? "shared"` is gone from
  the services.
- **Inherited writes read the parent.** A habit entry copies its habit exactly.
  A list item inherits the list and may only be narrower: a private item in a
  shared list is allowed, a shared item in a private list is refused. A
  trashed, foreign or private-to-another-member parent refuses the write. The
  pre-Slice-2 list-item wire shape with **no** list id is a legacy carve-out:
  it stays readable, but any client-supplied visibility is forced `private`
  (owner-only) and an omitted visibility keeps the legacy shared default. A
  list id that names no row is dangling (hard-purged parent), is refused on
  write, and is never delivered.
- **The sync registry derives the same value.** Fixed classes ignore any
  stored value on the write and resolve from the policy; inherited classes are
  resolved by the engine before the row is written.
- **Inherited reads resolve the parent now.** `/sync/pull` and `/sync/bootstrap`
  check the parent's _current_ visibility, not the child's write-time column.
  A parent that becomes private (or is hard-purged) also emits removals for its
  existing children, so the partner's mirror drops the items/entries even when
  the children have no new feed rows of their own.
- **A fixed or exact-inherited visibility cannot be changed by a push.**
  A patch that carries `visibility` on an owner-only, household or exact-inherit
  aggregate is rejected (`VisibilityFixed` / `VisibilityInherited`) rather than
  silently ignored or coerced.

### Shared means co-edit; only the owner can un-share

`shared` means the other household member may read and edit the row. The
partner must not be able to lock the author out of their own row, so flipping a
row to `private` is an owner-only action on every shareable aggregate: lists
and habits already enforced this, list items narrowed the same way, and tasks,
events, notes, reminders and occasions now do the same (service and sync push).
Any member may share a row back.

### What "private" means

`private` hides a row from the partner's reads, pulls and feed. It is **not**
encryption at rest: the row is stored in the same D1 database and is visible to
whoever can read that database. The promise is about the product's two-member
sharing boundary, not about protecting data from the operator.

## Consequences

- The default lives in one table. A new default is a policy change, not a grep
  for `"shared"`.
- SQL column defaults on the affected tables follow the policy for a fresh
  database (`notes`, `habits`, `reminders`, `occasions` and `habit_entries`
  default to `private`; `list_items` keeps the list default `shared`). No
  backfill was performed: this is a stage environment and existing rows do not
  matter. Every writer supplies the resolved value, so the column default is
  only a safety net.
- A legacy row that stored `private` on a household aggregate is rewritten to
  `shared` by its next sync write; a legacy private habit entry under a shared
  habit is rewritten to the habit's value. Conversely, un-sharing a habit or
  list immediately removes its entries/items from the partner's pull and
  bootstrap, and the child rows converge on their next write.
- The UI renders a visibility control only for `shareable` aggregates. The
  list screen keeps its existing select; Notes, Events, Tasks, Habits,
  Reminders and Occasions get a Share / Unshare action on their existing edit
  surface. Create forms use the policy default and do not grow a checkbox.
