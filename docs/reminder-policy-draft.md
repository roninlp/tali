# Tali — Reminder Scheduling Policy (Draft)

> **Status:** PROTOTYPE — a proposed policy for the owner + developer to react to. Not a final contract.
> **Ticket:** [#13](https://github.com/roninlp/tali/issues/13) (HITL grilling)
> **Source authority:** `docs/product-requirements-v2.html` §8 (FR-REM-01/02/03 + edge cases) and §2.4 (principles 4 «احترام به تمرکز» and 7 «قابل اعتماد بودن»), `docs/must-have-feature-map.html` FR-REM-01/02/03 + Slice 3 + §10 acceptance, `docs/domain-model-draft.md` §3.6 (`Reminder`, `ReminderDispatch`, `ReminderLink`).

---

## 1. Guiding constraints (already settled — do not re-litigate)

1. **Data model** (`docs/domain-model-draft.md` §3.6): `Reminder` carries `kind` (`ReminderType` = medication/exercise/chore/general), `tier` (`ReminderTier` = normal/critical — "critical = medication"), `repeat` (`ReminderRepeat` = once/daily/weekly/interval-hours), `fireAt` (next-fire instant), `link` (`ReminderLink` = none/habit/task/event), `silencedUntil` (snooze / "silence until"). `ReminderDispatch` is the per-delivery ledger with `scheduledFor`, `deliveredAt`, `response` (`done|snooze|dismiss`), `respondedAt`, `snoozedUntil`, `userId`.
2. **Delivery** (map FR-REM-02): cron every minute scans due-undelivered reminders; Web Push via typed gateway with retry/backoff; dispatch ledger + missed-reminder inbox is the closed-browser source of truth. **Quiet hours queue, never drop.**
3. **Tier** (map FR-REM-01): "type selector controlling tier and actions" — the reminder *type* drives its *tier*.
4. **Edge cases that are hard Must constraints** (PRD §8.3):
   - یادآور‌های از‌دست‌رفته هرگز بی‌سروصدا حذف نشوند — *missed reminders are never silently dropped.*
   - در ساعات «سکوت» اعلان‌ها بی‌صدا جمع شوند و در اولین فرصت نمایش داده شوند — *during quiet hours notifications queue silently and are shown at the first opportunity.*
   - یادآور‌های حساس (دارو) نباید با «حالت تمرکز» خاموش شوند، مگر با تأیید صریح کاربر — *medication reminders are not suppressed by focus/quiet unless the user explicitly consents.*
5. **Product principles:** principle 4 «احترام به تمرکز» (gentle, configurable, meaningful notification) outranks raw volume; principle 7 «قابل اعتماد بودن» (nothing vanishes without trace) outranks inbox tidiness.

---

## 2. Proposed policy

Each subsection states a **draft default** and cross-references the open decision it hangs on (§4).

### 2.1 Quiet hours

- **Draft default window: `23:00 → 07:00` local time** (the PRD's own example in FR-REM-04 is «۲۳ تا ۷»), evaluated in the *owner's* IANA `timeZone` (per-`User`, not per-household).
- **Behavior during the window:** normal-tier reminders do **not** push. They are *queued* (their `ReminderDispatch` is created with the original `scheduledFor`, left undelivered) and flushed at the first opportunity — the window's end (or next app open, whichever comes first).
- **Critical (medication) tier bypasses quiet hours** (see §2.2) unless explicitly silenced.
- **Note on scope:** the *behavior* (queue-during-window) is Must; the *settings UI* to configure the window is FR-REM-04 = **Should** (deferred). Must ships the fixed default above unless the owner pulls the config forward.

### 2.2 Medication (critical) tier

- `kind = "medication"` → `tier = "critical"` **automatically**; every other kind → `tier = "normal"`. The user never assigns tier by hand in the MVP (the type selector controls it — map FR-REM-01).
- **Critical reminders are never suppressed by quiet hours or any focus-style toggle.** The only thing that silences them is an **explicit, per-reminder** `silencedUntil` set by the user ("silence until date/time").
- What counts as "explicit consent" is a real decision (§4 #3) — the draft answer is: *only a deliberate per-reminder silence action, never a global quiet-hours window.*

### 2.3 Snooze and silence-until

Two distinct controls, mapped to the two existing fields:

| Action | Field | Semantics (draft) |
|---|---|---|
| **Snooze X minutes** (single occurrence) | `ReminderDispatch.snoozedUntil` (+ a new dispatch) | Re-fire *this* dispatch at `now + X`. Does **not** shift the series schedule for a repeating reminder — the next scheduled occurrence still fires normally. |
| **Silence until date/time** (whole series) | `Reminder.silencedUntil` | Pauses *all* next-fire calculation for the reminder until the date. The only way to quiet a critical/medication reminder. |

- **Draft snooze presets (X): `5, 10, 15, 30, 60` minutes.** Five fixed options, no free-form entry in the MVP (simplicity-by-default). The exact set is open (§4 #4).

### 2.4 Missed-reminder inbox

- **Definition of "missed" (draft):** a dispatch where `scheduledFor < now` **and** `response = null` — i.e. unanswered, whether or not a push was ever delivered. This deliberately folds "browser closed, never delivered" and "delivered but ignored" into one inbox so nothing slips through.
- **When items appear:** as soon as they satisfy the definition, surfaced (a) in the service-worker notification where possible, and (b) in the in-app missed-reminder list on app open.
- **When items clear:** any response (`done` / `snooze` / `dismiss`) clears the item from the *inbox view*; it does **not** delete the ledger row (the response history is permanent — FR-REM-03).
- **Age-out without silent drop:** unanswered items older than a threshold roll off the *inbox view* into the *response history*, never silently deleted. The threshold is open (§4 #6); the "never silently dropped" guarantee means the data always survives in the ledger.

### 2.5 "Done" → linked Habit/Task

The dispatch response is the idempotency key: applying "done" twice does not double-apply (re-responding to an already-`done` dispatch is a no-op).

| `ReminderLink` | Effect of `done` (draft) |
|---|---|
| `none` | Log `response = "done"` only (feeds adherence). |
| `task` | Set `Task.status = "done"`, `completedAt = now` (idempotent if already done). |
| `habit` | **Upsert** today's `HabitEntry` → `status = "done"` keyed by `(habitId, localDate)` (owner tz), within the ≤7-day backdating window. |
| `event` | **Log-only** — events have no done/completed state (open §4 #7). |

### 2.6 Adherence metric (on-time %)

- **Source:** the `ReminderDispatch` ledger (map FR-REM-03: "adherence metric source (on-time %) retained").
- **Draft definition — a dispatch is "on-time" iff** `response = "done"` **and** `respondedAt <= scheduledFor + graceWindow`, where `graceWindow = 30 minutes` by default. Early "done" (before `scheduledFor`) counts as on-time. `dismiss` and unanswered dispatches are *not* on-time.
- **Aggregation:** computed per reminder and rolled up per `kind` (the PRD cares about «درصد مصرف به‌موقع دارو» — % on-time medication intake) over 7/30-day windows, targeting ≥90% for medication (map §10).
- **Scope note:** the metric is *retained* in Must (the ledger already holds it). A full report UI is out of scope (FR-VIEW-04 deferred); the draft adds at most a single "on-time %" figure on the reminder detail.

---

## 3. Data-model touchpoints

No new entities are required for the policy. The following small additions/changes are implied (each flagged in §4):

- **`User.quietHours`** — per-user window `{ start: "HH:mm", end: "HH:mm", timeZone }`, default `23:00–07:00`. Not currently in `domain-model-draft.md`; adds one optional field.
- **`Reminder.tier` derivation** — `kind`→`tier` is computed at write time (no user input), consistent with the existing comment "critical = medication".
- **`Reminder.silencedUntil`** — repurposed as the *series* silence; `ReminderDispatch.snoozedUntil` is the *single-occurrence* snooze. The two must be kept distinct in code (they already are, structurally).

---

## 4. Open decision points (HITL — for the humans to settle)

1. **Default quiet-hours window — is `23:00–07:00` right, and is it per-user?**
   *Recommendation:* **`23:00–07:00` local, per-`User`** (each owner's own tz), matching the PRD example. Per-household is rejected — "respect for focus" is personal. Config UI stays deferred (FR-REM-04 Should); Must ships the fixed default unless you want the settings pulled forward.

2. **Is the quiet-hours *settings UI* in Must or deferred?**
   *Recommendation:* **Deferred.** The queue-never-drop *behavior* is Must (§8.3.2); the configurable window is Should (FR-REM-04). Shipping only the fixed default keeps Must honest. *Sub-question:* if you want it, where does the window live — a new `User.quietHours` field (draft) vs a household-level setting?

3. **What counts as "explicit consent" to silence a medication reminder?**
   *Recommendation:* **only a deliberate per-reminder `silencedUntil`**, never the quiet-hours window and never a global toggle. A critical reminder inside quiet hours fires on time; the sole escape hatch is "silence until" set on *that* reminder. (This satisfies §8.3.3 without a full "focus mode", which is already out of scope.)

4. **Snooze preset set — `{5, 10, 15, 30, 60}` minutes?**
   *Recommendation:* **yes, fixed five presets, no free-form.** Medication needs short snoozes (5/10); chores/general rarely need <15. Free-form entry is rejected for the MVP (simplicity-by-default).

5. **Does "snooze X minutes" re-fire *this* occurrence or shift the *series*?**
   *Recommendation:* **this occurrence only** — set `ReminderDispatch.snoozedUntil = now + X` and leave the repeating schedule untouched. "Silence until date" is the separate, series-level control (`Reminder.silencedUntil`). This keeps the two fields' meanings crisp and matches FR-REM-01's «تعویض موقت» (temporary) vs «سکوت تا تاریخ» (silence until date).

6. **Does "delivered but ignored" count as *missed* (inbox), and how long do unanswered items linger before rolling off to history?**
   *Recommendation:* **yes — unanswered = missed**, regardless of delivery (nothing slips through); items **roll off the inbox into history after 24 hours**, but are *never deleted* (ledger is permanent). Sub-decision: is 24h right, or should it be 7 days / "until next app open"? The "never silently dropped" guarantee is fixed either way.

7. **What does "Done" do on an *event*-linked reminder?**
   *Recommendation:* **log-only.** Events have no done/completed state; forcing one would warp the calendar model. If you later want "attended" semantics, that's a new field on `Event`, out of Must scope.

8. **Adherence "on-time" definition — is a 30-minute grace window right?**
   *Recommendation:* **on-time = `done` with `respondedAt <= scheduledFor + 30 min`**, early-done counts as on-time, `dismiss`/unanswered are not on-time. Sub-question: does a *snoozed-then-done* count as on-time or late? Draft counts it as **late** (the final `done` is after grace) — but if you want snooze to be "free", we count by first non-snooze response instead.

9. **Where does the on-time % surface in Must — a single number, or a report?**
   *Recommendation:* **single "on-time %" number on the reminder detail** (from the ledger), no full report. FR-VIEW-04 (weekly/monthly reports) is deferred; the ledger already retains everything needed so the report can come later for free.

---

## 5. Deliberately out of scope

- **Notification center + sound/vibration/quiet-hours *settings*** (FR-REM-04, Should) — only the fixed quiet-hours default ships.
- **Location-based reminders** (FR-REM-05, won't-now).
- **Focus mode** as a feature (already out of scope on the map) — §8.3.3 is satisfied by the per-reminder silence rule, not a focus toggle.
- **Full adherence reports** (FR-VIEW-04) — metric retained, not reported.
