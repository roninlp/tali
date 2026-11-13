# Verification runbook

Ticket: [#86](https://github.com/roninlp/tali/issues/86) · Strategy:
[#81](https://github.com/roninlp/tali/issues/81) · Acceptance criteria:
`docs/must-have-feature-map.html` §10 (Must scope)

This is the whole of "what proves the Must MVP ships", written so someone who
was not in the session can run it. Three automated layers, two gate suites, one
recorded human week. Nothing here is aspirational: every command below is the
command CI runs.

**Sign-off is the two-user acceptance week** (§ [Sign-off](#sign-off-the-two-user-acceptance-week)),
recorded in [`docs/acceptance-week.md`](acceptance-week.md). Everything else in
this runbook exists to make that week trustworthy.

---

## 1. The layers, and what belongs in each

Each layer has one job. A test belongs to the lowest layer that can see the
thing it asserts.

| Layer | What it proves | Where | Command | Runs |
| --- | --- | --- | --- | --- |
| **Domain unit** | Pure rules: recurrence, Jalali conversion, streak periods, reminder policy, task buckets, sync merge rules, error mapping, Foldkit model/view updates | `packages/domain`, `packages/sync-client`, `apps/web-foldkit/src/**/*.test.ts` (scene/story/model) | `pnpm test` (whole repo) | every PR |
| **Service + SQL integration** | Services against real SQL on `fake-d1`: schema, migrations, CAS, one-batch writes, feed/ledger, search index, purge, backup | `apps/api/test/*.test.ts` | `pnpm --filter @tali/api test -- --project service` | every PR |
| **Boundary** | The real Worker module in workerd through real `fetch`: routing, `requestUrl`, CORS-with-credentials, cookie minting, RPC, sync routes, reminder respond | `apps/api/test/boundary/*.test.ts` (`@cloudflare/vitest-plugin`) | `pnpm --filter @tali/api test -- --project boundary` | every PR |
| **Convergence lab** | Two real client engines (each on its own IndexedDB) against the real Worker: mirror/server equality including tombstones, ack coverage, exactly-once replay, monotonic versions, cursors | `packages/conflict-lab` | `pnpm --filter @tali/conflict-lab test` (bounded) · `test:nightly` (long) | bounded: PR · long: nightly |
| **Gate flows (E2E)** | The five flows a user would notice breaking, end to end in a browser, on a real local stack | `packages/e2e/tests/01..05-*.spec.ts` | `pnpm test:e2e` | nightly · local before sign-off |
| **Accessibility pass** | One axe run per primary route and both guest screens, zero WCAG 2.1 A/AA violations (minor-impact rules excluded) | `packages/e2e/tests/06-a11y.spec.ts` | `pnpm test:e2e` | nightly · local before sign-off |

The boundary layer earns its place: reverting the request-URL fix fails 6 of 9
sync tests ([#82](https://github.com/roninlp/tali/issues/82)). The conflict lab
earns its place: it found that `applied_mutations` ids are global, so reused
test ids were silently mislabelled ([#83](https://github.com/roninlp/tali/issues/83)).
Do not move a test down a layer to make it faster; move it up when a bug it
should have caught shipped.

### What is deliberately **not** in CI

- **Wall-clock assertions.** No test asserts a duration; the gate flows record
  nothing into the performance baseline (§4). CI hosts are too noisy for a
  threshold, and a flaky perf gate gets muted.
- **Real Web Push delivery.** `alchemy dev` cannot deliver push and Playwright
  cannot click an OS notification. Flow 4 writes exactly the queue record the
  service worker writes, then runs the shipped drain. Actual delivery is proven
  by the unit/service tests (ES256 VAPID + aes128gcm) and by the acceptance
  week on a deployed stage.
- **A real app-shell cache.** The SPA caches no app shell (out of Must scope),
  so flow 2 cuts only the API origin and reloads; the app boots from
  IndexedDB. See `packages/e2e/README.md` §Seams.
- **Dark theme and 320px layout, in axe.** The a11y pass runs the default
  theme at desktop width. Contrast in the dark theme and overflow at 320px are
  part of the acceptance week's manual checklist.

---

## 2. Run everything locally

Prerequisites: Node ≥ 24, pnpm 12.6 (via `corepack`), a checkout, and once:

```sh
pnpm install
pnpm --filter @tali/e2e install:browsers   # Chromium for Playwright
```

### The PR suite (what CI gates a merge on)

```sh
pnpm typecheck          # Vite Task → every package
pnpm quality            # lint (Oxlint + Effect rules) + format
pnpm build
pnpm test               # unit + service + boundary + bounded conflict lab
```

`pnpm test` is the whole fast net; it takes a few minutes cold and reuses the
Vite Task cache after that. The API's two layers are one command with two projects:

```sh
pnpm --filter @tali/api test                       # both projects
pnpm --filter @tali/api test -- --project service   # fake-d1 only
pnpm --filter @tali/api test -- --project boundary  # workerd only
```

One file, when you are chasing a single failure:

```sh
pnpm --filter @tali/api exec vitest run test/sync.test.ts
pnpm --filter @tali/api exec vitest run test/boundary/sync.boundary.test.ts
```

### Convergence lab

```sh
pnpm --filter @tali/conflict-lab test          # 20 programs × 40 steps (~bounded)
pnpm --filter @tali/conflict-lab test:nightly  # 100 programs × 70 steps (~2.5 min)
```

A fast-check failure prints a shrunk program; the deterministic table in
`test/regression.test.ts` is where a newly discovered race becomes a permanent
case.

### Gate flows and the accessibility pass

```sh
pnpm test:e2e
```

The runner boots `alchemy dev --stage e2e` itself: a fresh local D1 with the
real migrations, the api Worker on `:8787`, the Foldkit SPA on `:3001`. Two
rules:

- **Stop `pnpm dev` first.** Ports are pinned; the preflight fails loudly rather
  than attach to the developer stack and run against real local data.
- **One worker, no retries.** A retried flow would hide the ordering flake the
  suite exists to prove absent.

One spec at a time:

```sh
pnpm --filter @tali/e2e exec playwright test tests/06-a11y.spec.ts
pnpm --filter @tali/e2e exec playwright test tests/04-reminder.spec.ts
E2E_KEEP_STATE=1 pnpm --filter @tali/e2e exec playwright test tests/02-offline-task.spec.ts
```

`E2E_KEEP_STATE=1` keeps the `e2e` stage's D1 (`infra/.alchemy/state/tali/e2e`)
so you can inspect the rows a failing flow left behind. A normal run deletes it.

**Selectors are the fragile part.** The flows target the accessibility tree
(`getByRole`, `getByLabel`) wherever the markup has a name, and a `data-`
attribute only where it does not (`[data-today-source]`, `li[data-done]`,
`[data-calendar-*]`). Class names are not a contract — the Tailwind refactor in
`81b229d` removed `.today-list`, `.lists-item` and `.lists-index-card` and left
the suite red until the selectors moved. If a flow needs a hook, add a real
`aria-label` first (the a11y pass benefits too); add a `data-` attribute only as
a last resort, and never restore a class name just to keep a test green.

### Focused smoke checks (against your development stack)

Different from the gate flows: these need `pnpm dev` already running and use
the local `dev_<user>` database.

```sh
pnpm test:smoke:foldkit        # register → household → invite → session restore → guards
pnpm test:smoke:foldkit:sync   # online write → offline write → reload ×2 → reconnect → converge
```

Use them while developing auth or sync. Never as sign-off evidence: they mutate
the development database.

### Manual triggers on a local stack

Everything cron-driven can be driven by hand; see
[`docs/backup-restore.md`](backup-restore.md) for the purge/backup drills and
the restore procedure.

```sh
# Reminder sweep at a chosen instant (dev-only route)
curl -X POST "http://localhost:8787/dev/reminders/sweep?at=2026-11-09T06:00:00.000Z"

# Any scheduled job, through workerd's scheduled route
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=47+3+*+*+*&time=$(date +%s000)"
```

---

## 3. CI: what runs when, and how to reproduce a red run

| Workflow | Trigger | Jobs |
| --- | --- | --- |
| `.github/workflows/ci.yml` | every PR, every push to `main` | typecheck · quality (lint+format) · build · test (unit + service + boundary + bounded conflict lab) |
| `.github/workflows/nightly.yml` | `17 2 * * *` UTC, and manual | `conflict-lab` (long randomised run, 45 min budget) · `gate-flows` (Playwright: 5 flows + a11y, 20 min budget) |
| `.github/workflows/deploy.yml` | push to `main`, manual | `pnpm stack:deploy -- --yes` to the pinned `ALCHEMY_STAGE` (default `demo`); skipped with a warning when the Cloudflare/VAPID secrets are absent |

CI pins `TZ=UTC` and sets `CI=true`; the gate flows run one Chromium worker
against a fresh `e2e` stage.

### Reproducing a nightly failure

1. Open the failed run → the failing job.
2. **Gate flows**: download the `gate-flows-artifacts` artifact (14-day
   retention). It holds `test-results/` (trace, video, screenshot, and the
   `seeded-state.json` attachment with the ids the flow minted) and
   `playwright-report/`.

   ```sh
   pnpm --filter @tali/e2e exec playwright show-trace <path>/trace.zip
   pnpm --filter @tali/e2e exec playwright show-report <path>
   ```

   Then reproduce locally with the same seed the artifact records:
   `E2E_KEEP_STATE=1 pnpm --filter @tali/e2e exec playwright test <spec>`. The
   flows mint unique ids per run, so the same database can be reused; the
   attachment tells you which identities and rows to look at.
3. **Conflict lab**: the failure message carries the shrunk program (the
   sequence of device operations). Run the bounded suite locally first
   (`pnpm --filter @tali/conflict-lab test`); if it does not reproduce, run the
   nightly flag once (`CONFLICT_LAB_NIGHTLY=1`) and add the trace to
   `test/regression.test.ts` before fixing anything.
4. **Flake policy**: a gate flow that fails once is a bug until proven
   otherwise. Do not add `retries` to hide it — the suite is one worker with no
   retries on purpose. If a flow is genuinely timing-dependent, fix the
   synchronisation, not the timeout.

Manual dispatch runs both nightly jobs:

```sh
gh workflow run nightly.yml
```

---

## 4. Accessibility pass

`packages/e2e/tests/06-a11y.spec.ts` runs axe on `/today`, `/calendar`,
`/tasks`, `/habits`, `/lists`, `/notes`, `/reminders`, `/settings`,
`/household`, `/capture` in the signed-in shell, plus `/login` and `/register`
in a fresh signed-out context. Rule tags: `wcag2a`, `wcag2aa`, `wcag21a`,
`wcag21aa`. The assertion is **zero violations** above `minor` impact.

A failure names the rule, the impact, the help URL and up to three offending
selectors:

```text
/today: 1 accessibility violation(s)

  color-contrast (serious): Elements must meet minimum color contrast ratio thresholds
    https://dequeuniversity.com/rules/axe/4.14/color-contrast?application=playwright
      section[data-section="events"] > … > .bg-base-200\/40
```

Fix the cause, not the selector. Contrast is the one that bites: secondary text
must clear 4.5:1, which in this theme means never going below
`text-base-content/70` on `base-100`/`base-200` surfaces. If a new screen has a
`minor`-only finding, it does not fail the gate but should be filed as an
issue.

**What axe cannot see** — checked by hand during the acceptance week:

- keyboard-only ordering and focus visibility (tab through every screen;
  focus ring visible on light, dark, and over the fixed mobile tab bar);
- Persian screen-reader phrasing and pronunciation of dates/amounts;
- RTL reading order and mirrored icons (chevrons, back arrows);
- no horizontal scroll at 320 px and at 200% zoom;
- dark theme contrast, which the automated pass does not cover.

Adding a route: add it to `SIGNED_IN_ROUTES` in the spec. The `main` landmark
must be visible first, so a screen that fails to render fails rather than
passing an empty audit.

---

## 5. Performance baseline

Two sets of numbers, one procedure. There are no wall-clock assertions in CI;
this is recorded by hand before sign-off and after any perf change.

**Targets**

| Metric | Must target (`feature map` §10) | P0 target (`docs/plans/latency-fixes/PLAN.md`) |
| --- | --- | --- |
| Quick add (task, note, or habit) | < 10 s on a phone, one hand | — |
| First full load | < 2 s on home internet / mobile | boot-to-interactive < 800 ms on a mid-range phone |
| Interaction latency (common mutation) | < 100 ms | in-app navigation < 150 ms warm, no full-screen splash |
| `/today` server response | — | p50 < 150 ms warm, < 350 ms cold |

**Procedure** (run against the deployed stage, never the local dev server, and
record every number in `docs/acceptance-week.md` §Performance):

1. Use a real mid-range Android phone (or Chrome DevTools with CPU ×4 and
   "Slow 4G"). Clear site data, sign in, then measure **cold first load**:
   `Performance` panel → reload → record `DOMContentLoaded`, LCP and "time to
   first interaction" (the moment the Today composer accepts text).
2. **In-app navigation**: tap Calendar → Today → Tasks, recording each
   navigation's paint time in the Performance panel. There must be no
   full-screen splash.
3. **Quick add**: start a stopwatch, type a task title in Today and press
   Enter; stop when the row is visible. Repeat for a note and a habit tap.
   Threshold is a human 10 s, so this is a real stopwatch, not a trace.
4. **Interaction latency**: with the Performance panel recording, complete and
   undo a task, check a list item, and log a habit. Read the input→paint gap;
   the optimistic write should paint well under 100 ms, with the network round
   trip arriving later.
5. **Server response**: from the target city, 20 sequential requests each to
   `/health` (no DB) and `/today` (11-ish D1 statements); record p50 and worst.
   `curl -s -o /dev/null -w '%{time_total}\n' <url>/today` in a loop is enough.
6. Five runs per metric, record p50 and worst. Compare against the targets
   above, not against another machine.

**D1 statement counts** were measured with a temporary instrumented D1 wrapper;
the numbers and method are in `docs/research/deploy-latency/00-synthesis.md` §1
(`/today` 11, `/week` 11, `/month` 11, `/sync/pull` 8 — the last one must now
be 7 reads and zero writes after the P0 fixes). To re-measure, re-add the
wrapper on a scratch branch; do not commit it.

---

## 6. Sign-off: the two-user acceptance week

The Must version is done when **both** users have planned, tracked, and reviewed
a full week using only Tali, and nothing on the way broke a Must obligation.

### Preconditions

- [ ] `main` is deployed to the target stage (`pnpm stack:deploy`, VAPID keys
      set — without them every reminder is inbox-only).
- [ ] The nightly `gate-flows` job is green on that commit.
- [ ] The accessibility pass is green.
- [ ] The performance baseline is recorded (§5).
- [ ] Both users have the app installed on their own phone (Add to Home
      Screen) and both accounts exist in one household.

### The week's script

Each day, both users do the same four things and record anything that bites:

1. **Morning plan** — open Today, add the day's tasks (at least one with a
   due time), check the shared list, look at the week.
2. **Through the day** — complete tasks, log habits, take a note, answer every
   reminder (Done or Snooze), add one occasion if it is that kind of day.
3. **One deliberate offline moment per day** — put the phone in flight mode,
   add a task and a note, use the app for a minute, reconnect, confirm both
   devices agree.
4. **Evening review** — check the Today dashboard counts, the week view, and
   the reminder inbox for anything missed.

Days 6–7 re-test the thing that broke earlier in the week. Both users use both
their own account and, at least once, the partner's device (shared household).

### Recording

Use [`docs/acceptance-week.md`](acceptance-week.md), one row per day per user
plus the metric table. For every failure: open an issue, link it from the day's
row, and label it **blocker** (a Must obligation broken: data loss, offline
core, reminder delivery/response, shared-list liveness, sign-in) or
**known-fix** (cosmetic, or a workaround exists). Fix blockers and re-run the
affected day; known-fixes become follow-up issues and are listed in the record.

### Exit

The week counts as signed off when:

- 7 days are recorded for both users, with all four daily steps done;
- zero open blockers (known-fixes may remain, listed);
- the metrics in the record meet the Must targets in §5, or the miss is
  written down with a decision to accept it;
- `docs/acceptance-week.md` is filled in, committed, and linked from
  [#86](https://github.com/roninlp/tali/issues/86).

Anything short of that is a finding, not a sign-off.
