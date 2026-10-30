# Foldkit migration — Phase 2 plan

**Status:** in progress. Phase 1 (scaffold), the Phase 2 prerequisites
(workspace-wide Effect 4.1, api proxy, typed RPC entry point), P2.1 (shell,
theming, RTL document), P2.2 (route union and navigation), P2.3 (auth and
session restore), P2.4 (local store and sync engine), and P2.5 (preferences,
theme, and push) are in place. P2.6 (feature screens) is in progress: Today,
Lists, Tasks, Habits, Notes, Reminders, and Settings are delivered; Occasions
and Calendar remain. P2.5's real vendor-push check is still blocked on a local
VAPID pair and a real browser; everything else is verified.

**Source of truth:** `apps/web` (Solid v2) for behavior, copy, and
interaction. **Target:** `apps/web-foldkit` (Foldkit + Effect). Do not edit
`apps/web` during migration work.

## Ground rules

- Port behavior, not code shape. A Solid component becomes a Foldkit
  Submodel/view; a Solid resource becomes a Command; a Solid effect becomes a
  Subscription.
- One PR-sized slice per step below. Each slice keeps `pnpm typecheck`,
  `pnpm build`, `pnpm test`, and `pnpm --filter @tali/web-foldkit lint` green.
- Every new module gets a Story or Scene test before it is wired to the shell,
  following `FOLDKIT.md` and the examples in `repos/foldkit/`.
- Shared values (routes, copy, policy) live in `@tali/domain` or a local
  `model.ts`; never import from `repos/foldkit`.
- The Foldkit app stays on :3001. The Vite proxy forwards the api Worker's
  routes to :8787; see `apps/web-foldkit/vite.config.ts` and
  `apps/web-foldkit/src/lib/config.ts`.

## Reuse map

| Legacy (`apps/web`) | In Foldkit | How |
| --- | --- | --- |
| `src/lib/rpc.ts`, `src/lib/config.ts` | `src/lib/rpc.ts`, `src/lib/config.ts` | Already ported as an Effect-returning helper |
| `src/lib/{auth,session-cache,preferences*,push}/*` | Commands + Model | Port behavior; replace Solid contexts with Model fields |
| `src/lib/local-store/store.ts` | `@tali/sync-client` + `src/sync.ts` | Pure rules extracted; IndexedDB behind a managed service; Model holds snapshots |
| `src/lib/sync-engine.ts`, `sync-cadence.ts` | `@tali/sync-client` + Commands/Subscriptions | Engine shared with the conflict lab; the runtime owns the timer chain |
| `src/routes/*`, `src/router.ts` | `src/route.ts` | Rebuild the route union; URL parser gets tests |
| `src/app.css`, `@tali/ui/base.css` | `src/styles.css` | Copy the CSS tokens/themes; components are Solid-only |
| `@tali/domain`, `@tali/rpc`, `@tali/config` | same packages | Import directly; one Effect instance via the catalog |
| `@tali/ui` components | new Foldkit views | Not reusable (Solid JSX + Solid reactivity) |

## Slices

### P2.1 — Shell, theming, and the RTL document

- Replace the starter (`src/page/People`, `src/fileTree.ts`, starter routes and
  their tests) with the Tali shell.
- `index.html`: `lang="fa" dir="rtl"`, title `Tali`, Vazirmatn from
  `packages/ui/src/fonts/vazirmatn-variable.woff2`.
- `src/styles.css`: Tailwind v4 + daisyUI, porting the `tali`/`talidark` theme
  tokens from `apps/web/src/app.css`; keep logical properties (`ms`/`me`,
  `ps`/`pe`, `start`/`end`).
- Add a `src/ui/` layer for the primitives the screens need (button, field,
  sheet, toast) — only what P2.2/P2.3 consume, not a speculative library.

**Done when:** `pnpm dev:foldkit` boots an RTL Persian shell with the house
theme on :3001; the starter is gone; a Scene test renders the shell.

**Delivered:** the starter (People, file tree, starter routes) is removed. The
document is `lang="fa" dir="rtl"` with the `tali` house theme, Vazirmatn from
`@tali/ui`, and the ported `styles.css` (tokens, utilities, base layer). The
shell is `src/shell.ts` (brand + action slot + main) and the theme is a
Submodel in `src/theme.ts` (house light/dark toggle; persistence and system
mode stay in P2.5). `src/ui/` ships the button and field primitives P2.2/P2.3
consume; sheet and toast wait for their first consumer.

### P2.2 — Route union and navigation

- Port the legacy route surface: `/`, `/login`, `/register`, `/today`,
  `/tasks`, `/lists`, `/lists/[id]`, `/notes`, `/notes/[id]`, `/notes/trash`,
  `/habits`, `/calendar`, `/reminders`, `/settings`, `/household`,
  `/push-health`, `404`.
- Keep `src/route.ts` pure: one tagged union, `urlToAppRoute`, typed routers.
  Unknown/deep paths map to `NotFound({ path })`.
- Wire `Runtime.makeApplication` routing as the `routing` example in
  `repos/foldkit/examples/routing` does; use Foldkit `Transition` only where
  the legacy app re-fetches on entry.

**Done when:** every route renders a placeholder with the right title and nav
state; URL parser tests cover each tag plus `NotFound`.

**Delivered:** `src/route.ts` declares the `AppRoute` union and one typed
router per route. Unknown and deep paths become `NotFound({ path })`, and the
list/note detail ids decode through the `@tali/domain` UUID v7 brands.
`entry.ts` wires `onUrlRequest`/`onUrlChange`, so internal links push history
and back/forward parse the URL again. `src/shell.ts` carries the desktop
section menu and the phone tab bar with `aria-current="page"`;
`sectionForRoute` keeps `/lists/[id]`, `/notes/[id]`, and `/notes/trash` on
their parent section. Every route renders its heading and document title.
Login, register, household, `/` and the 404 render outside the signed-in shell,
and the auth placeholders keep the theme toggle in a standalone layout. The dev
proxy passes browser navigations for `/household` and `/push-health` to the SPA
while API calls still reach the Worker.

No `Transition` is used yet: P2.2 has no data layer, so no route entry runs a
fetch. The feature slices add `Transition.make(model.route, nextRoute)` with
their first entry Command. P2.2 rendered the landing placeholder at `/`; P2.3
replaced it with the auth redirect.

### P2.3 — Auth and session restore

- Port `apps/web/src/lib/auth-api.ts`, `auth-copy.ts`, `auth.tsx`, and
  `session-cache.ts` behavior into Model + Commands.
- Login and register screens; boot restore (`/auth/me`), logout, and the
  authenticated-shell guard.
- Reuse `withRpcClient` for RPC; the auth HTTP calls follow the legacy
  `fetch` shape with `credentials: "include"`.
- Add a :3001 smoke check: register/login against the local stack through the
  proxy, reload, and land authenticated.

**Done when:** the legacy auth tests have Foldkit equivalents and the manual
smoke path passes under `pnpm dev` (which runs the api Worker and both
frontends).

**Delivered:** `src/lib/auth-api.ts` ports the plain-HTTP auth client with
`credentials: "include"` and the shared error-envelope shape;
`src/lib/auth-copy.ts`, `src/lib/login-key.ts`, and `src/lib/session-cache.ts`
carry the legacy copy, argon2id derivation, and local session hint.
`src/auth.ts` is the session Submodel: a discriminated `SessionStatus`
(`Restoring`, `SignedOut`, `SignedIn`, or `Failed`), boot restore, retry,
sign-out, and cache Commands. `src/page/login.ts`, `src/page/register.ts`, and
`src/page/household.ts` are the real screens, with Story and Scene tests.
`src/guard.ts` maps each route to guest, session, or household access; the root
applies it on URL changes, boot restore, and sign-out, and `/` resolves to
`/today`, `/household`, or `/login`. The shell header shows the display name and
an account menu with settings and sign-out. Session restore reads the cache
through runtime Flags before first paint and reconciles `/auth/me` once per
boot; a restore-attempt counter ignores late responses. Auth stays on plain
HTTP because the session cookie is set by the raw response; the data slices use
`withRpcClient`. The :3001 smoke check (`pnpm test:smoke:foldkit` with
`pnpm dev` running) registers, creates a household, reloads into `/today`,
signs out, and logs back in through the Vite proxy.

### P2.4 — Local store and sync engine

- Extract the pure parts of `local-store/store.ts` (schema, outbox, mirrors,
  coalescing) behind an IndexedDB service; the Foldkit Model holds the
  snapshots the views read.
- Port `sync-engine.ts` and `sync-cadence.ts` as Commands + Subscriptions
  (online/visibility/focus events, backoff, coalesced pull/push).
- Port `components/sync-runner.tsx` and `sync-status.tsx` as a Subscription and
  a status view.
- Keep the legacy test cases: offline quick-add, outbox replay, conflict
  resolution, and the two-device interleavings in `@tali/conflict-lab`.

**Done when:** a task created offline survives reload and syncs on reconnect;
the conflict-lab suite runs against the Foldkit client or its extracted core.

**Delivered:** the framework-free client core moved to `@tali/sync-client`
(`packages/sync-client`): the IndexedDB store (with the coalescing and mirror
rules extracted into pure modules), the sync engine, the cadence table, and
the task quick-add projection. `apps/web-foldkit/src/sync.ts` is the Foldkit
Submodel: the Model holds the store snapshot the views read (task rows, outbox
and failure counts, connectivity, failures), the IndexedDB mirror is a
`ManagedResource` keyed by the signed-in user, the engine runs in
`RunSyncPass` and the quick-add in `CreateTask`, and the wake rhythm is a
cadence `Subscription` driven by online/visibility/focus event streams.
`src/lib/sync-transport.ts` keeps `/sync/*` on plain HTTP and builds the two
habit repair paths with `withRpcClient`. `src/ui/sync-status.ts` is the status
pill in the app header. `/today` keeps its placeholder plus the temporary
local-first quick-add and mirror list the slice needs; P2.6 replaces it. The
store is opened only for a signed-in user and the sync loop only runs once
that user has a household, so onboarding never polls a 409. `@tali/conflict-lab`
now imports the extracted core, and its 19-test deterministic + property suite
still passes. The `:3001` sync smoke (`pnpm test:smoke:foldkit:sync` with
`pnpm dev` running) writes a task online, goes offline, writes another, reloads
twice, reconnects, and verifies the server feed and a second device converge.

### P2.5 — Preferences, theme, and push

- Port preferences (server-of-record + local cache; ADR-0002) into Model +
  Commands; restore the theme before first paint.
- Port `lib/push/*` (VAPID config, subscribe/unsubscribe, notification actions,
  service worker) and the push-health screen.
- Decide the service-worker scope for :3001 and document it; keep the legacy
  `apps/web` worker untouched.

**Done when:** theme survives reload; a test notification from
`pnpm test:push` opens the right screen; preference changes round-trip.

**Delivered:** `src/preferences-model.ts` is the plain projection of the
domain preferences row, `src/lib/preferences-api.ts` the `GET`/`PATCH` client,
and `src/lib/preferences-cache.ts` the synchronous `tali.preferences.v1.<id>`
read cache. `src/preferences.ts` is the Submodel: it adopts the cache before
the network settles, reconciles `/preferences` once per signed-in identity,
patches only the fields the settings form changed, and never enters the sync
outbox (ADR-0002). `/settings` now renders the real display-preferences form,
source badge, retry, and save confirmation; the password form followed in
P2.6, and the legacy `/settings` route has no household or trash surface. Auth
stays on plain fetch; the data slices still use `withRpcClient`.

`src/theme.ts` now ports the legacy gallery and light/dark/system mode. The
choice is device-local (`tali.theme` / `tali.mode`), `public/theme-boot.js`
applies it before first paint, and the Model starts from the same storage
values so the first render cannot flash the house light palette. The settings
screen carries the gallery picker; the header keeps the sun/moon toggle.

`src/push.ts` ports the VAPID, subscription, notification-action, and
permission-health behavior from `apps/web/src/lib/push/*` into a Submodel.
`src/lib/push/` holds the Effect-returning client pieces, the IndexedDB
Done/Snooze queue, and the service-worker helpers. `/push-health` is the real
diagnostic screen, and `/settings` embeds it. `public/sw.js`,
`manifest.webmanifest`, `theme-boot.js`, and the icons are copied from the
legacy app; the worker is registered at `/sw.js` with scope `/` on the :3001
origin, which is a separate service-worker registration from the untouched
legacy worker on :3000. The queue drains through `POST
/reminders/dispatches/:id/respond`; Vite proxies `/reminders` for that path.

The local stack had no `VAPID_PRIVATE_KEY`, so `GET /push/vapid` returns
`null`, the panel correctly disables enabling, and `pnpm test:push` stops at
the missing key. A generated pair plus a manual subscription in Playwright's
Chromium let the harness reach the vendor endpoint, but Chrome for Testing's
FCM endpoint rejected the send with HTTP 403, so no real notification could be
delivered in this environment. The notification-click path was verified in
headless Chromium by dispatching the worker's real `notificationclick` handler:
a body tap targets `/reminders`, and a synthetic Done tap queues, drains, and
shows in the health panel. A real device/browser with a matching local VAPID
pair remains the only unverified part of the acceptance.

### P2.6 — Feature screens

Port in this order, each as its own PR with Story/Scene tests and a parity
checklist against the legacy screen:

1. Today (`routes/index.tsx`, `today.tsx`, `lib/today/*`)
2. Tasks (`routes/tasks.tsx`, `components/tasks/*`, `lib/tasks/*`)
3. Lists (`routes/lists/*`, `lib/lists/*`)
4. Habits (`routes/habits.tsx`, `lib/habits/*`)
5. Notes (`routes/notes/*`, `lib/notes/*`)
6. Occasions (`lib/occasions/*`, calendar lanes)
7. Calendar (`routes/calendar.tsx`, `lib/calendar/*`, `lib/events/*`)
8. Reminders (`routes/reminders.tsx`, `lib/reminders/*`)
9. Settings (`routes/settings.tsx`, `lib/preferences*`, the password form, and
   the embedded push-health panel)

**Done when:** the legacy app has no behavior the Foldkit app lacks; the
Playwright gate flows can run against :3001; the legacy app can be retired.

**Delivered — Today:** `src/page/today.ts` is the page Submodel and
`today-model.ts` / `today-view.ts` hold its pure aggregation and view.
`src/mirror.ts` projects the IndexedDB rows the screen reads (tasks, notes,
habits, entries), and `src/sync.ts` now carries that mirror snapshot and the
pending-entity keys in its Model, so every feature screen can read the same
live rows. `src/lib/today-api.ts` is the plain-HTTP `GET /today` client with
ETag revalidation; Vite proxies `/today` for API calls while browser
navigations still return the SPA. `/today` renders the real dashboard: the
server read model when online with a drained outbox, mirror aggregation
otherwise, pending/dirty overlays that keep optimistic writes from flashing
back, the quick-add, complete and move-to-tomorrow local writes, the keyboard
cursor and timeline, the saved section order with its server PATCH, the
habits lane (tap cycling and streak copy) and the pinned-note lane. The
temporary P2.4 quick-add and mirror list are removed. The `:3001` auth and
sync smoke checks still pass; the sync smoke now drives the real Today list.
One small legacy interaction is still missing: a half-typed quick-add title
is not persisted across a reload (the P2.4 draft save/restore was removed
with its temporary surface).

**Delivered — Lists:** `src/page/lists.ts` is the shared index/detail Submodel
and `lists-view.ts` / `list-view.ts` hold their views. `src/lists-model.ts`
projects the mirrored List and ListItem rows and carries the
manual/alpha/status ordering, checked placement, reorder helpers, index
summaries and pending keys; `src/mirror.ts` now reads those two entity types
into the live snapshot and `src/lib/list-writes.ts` ports the local-first
writes. `/lists` creates lists with a title, colour, icon and privacy, shows
open/checked counts and a two-item preview, and deletes with the legacy
confirmation. `/lists/[id]` renames, changes sort/placement/visibility, adds
items continuously, checks with an undo toast, reorders by arrow buttons and
drag, and deletes items or the list. Every write commits the IndexedDB mirror
row and outbox entry together; no list write uses RPC. The list id arrives
through the existing `ListId` route parser, the screen CSS is ported into
`styles.css`, and the legacy model/mirror/screen cases are covered by Story and
Scene tests. The legacy screens expose no item rename, description, colour or
tag editors, so those stay out of scope; the mirror write helpers remain ready
for a later slice.

**Delivered — Tasks:** `src/page/tasks.ts` is the page Submodel and
`tasks-model.ts` / `tasks-view.ts` hold the board's pure grouping, filters,
sort, date copy, and view. `tasks-view-cache.ts` keeps the legacy
`tali.tasks.view.v1.<id>` localStorage key and JSON shape, so a browser that
used the Solid app keeps its saved filter/sort view; the boot flags read it
synchronously, so the first paint has the right board. `src/mirror.ts` now
projects Project and Tag rows into the shared snapshot, and
`src/lib/task-writes.ts` adds the patch/project/tag helpers the board writes
through. `/tasks` renders the real three-board workspace from the mirror:
today/upcoming/inbox groups with counts and empty copy, the quick add (title,
due presets, priority, project/tag selection, inline project/tag creation),
the persistent filter panel (project/tag/priority/status/date, sort field and
direction, counts, clear), inline card editors (title, description, due date,
priority, status, project, tags) with debounced local autosave and
saving/saved/error state, one-tap day moves, completion with an undo toast,
and the seven-day completion history with restore. Writes stay local-first
through the sync store and the outbox; no screen command calls RPC.
Drag/drop moves a card between boards with native HTML5 drag state, while the
always-visible move buttons keep the same moves keyboard and touch operable.
Parity gaps: the legacy completion "ghost" animation is not rendered (the
card leaves as soon as the mirror refresh lands) and drag/drop has no keyboard
equivalent beyond the move buttons. The quick-add saved line clears after the
legacy two-second window, and the transient quick-add draft resets on route
entry like the legacy remount.

**Delivered — Habits:** `src/page/habits.ts` is the `/habits` page Submodel and
`habits-view.ts` / `habits-heatmap-view.ts` hold the form, list cards, and
monthly Jalali heatmap. `src/habits-model.ts` now also carries the heatmap
month projection, the weekday/form presets, the pending-key helper, and the
habit's clock/zone helpers; `src/lib/habit-writes.ts` ports the local-first
create, edit (with the frequency-era boundary), soft delete, and restore
writes. The screen creates a habit with title, description, icon, colour,
daily/weekdays/N-times-a-week frequency, and an optional reminder; edits reuse
the same form; deleting asks the legacy confirmation and offers the 8-second
undo toast that restores the same row. Cards show the tap cycle (Done →
Partial → Missed), the recomputed streak badge, the 7/30/90-day rate copy, the
counting-period note, the reminder, pending and sync-error badges, and an empty
state. Every card can open its monthly heatmap with month navigation, weekday
labels, raw done/partial/missed/blank cells, a today marker, and the legend.
All writes commit the IndexedDB mirror row and outbox entry together; no habit
write uses RPC. The legacy screen's tests are covered by `habits-model.test.ts`
(writes, streak/rate edge cases, heatmap), `habits.story.test.ts` (update and
Commands), and `habits.scene.test.ts` (rendered views), and the screen CSS is
ported into `styles.css`. The sync engine's restore-refusal notice is surfaced
from the sync error as the legacy screen did.

**Delivered — Reminders:** `src/page/reminders.ts` is the `/reminders` page
Submodel and `reminders-view.ts` holds the inbox panel. `src/lib/reminders/api.ts`
is the plain-HTTP ledger client with `credentials: "include"`, ported from
`apps/web/src/lib/reminders/api.ts`; it keeps the legacy status-to-code
classification and the local plain response schemas so no branded domain value
crosses the dev optimizer's `effect/schema` boundary. The screen reads
`GET /reminders/inbox` and its `?history=1` page, renders title, scheduled time,
kind and critical/medication badges, the optional note, and each row's
Done/Snooze/Dismiss actions with the preset snooze select. Opening the screen,
returning to the tab, and the worker's `tali:reminder-action` message first
drain the service-worker Done/Snooze queue through the existing
`src/lib/push/notification-actions.ts` helpers and then re-read the ledger;
answers post to `POST /reminders/dispatches/:id/respond`, disappear
optimistically, and surface the legacy failure copy. The panel keeps the
loading spinner, error alert, inbox/history empty copy, history/back toggle,
and footer hint, and `/reminders` composes the push-health panel above it as the
legacy route did. The legacy API and inbox cases are covered by
`src/lib/reminders/api.test.ts`, `reminders.story.test.ts`, and
`reminders.scene.test.ts`; no screen command uses RPC or the sync outbox.

**Delivered — Notes:** `src/page/notes.ts` is the shared index/editor/trash
Submodel and `notes-view.ts` / `note-view.ts` / `notes-trash-view.ts` hold the
views. `src/lib/note-body.ts` keeps the plain-text/ProseMirror envelope and now
exposes the raw editor title; `src/lib/note-draft.ts` ports the crash-draft
parse/reconcile rules; `src/lib/note-search.ts` ports the variant-insensitive
local search; `src/lib/note-search-api.ts` is the plain-HTTP `GET
/search/notes` client; and `src/lib/note-writes.ts` ports create, content save,
pin, archive, tag, trash and retry writes with the legacy per-note save queue
and identical-save dedupe, plus the server-row projection a restore adopts.
`src/mirror.ts` now also projects the trashed-note rows and each note's
sync-error code, while the Today pinned-note lane reads the same live rows
unchanged. `/notes` renders pinned, active and archive sections, tag filters,
create, pin/archive/trash actions, pending and sync-error badges, the
empty/offline states, and server-first search with the mirror fallback (marked
titles and snippets). `/notes/[id]` loads from the mirror and crash draft,
autosaves body text after 700 ms and the draft after 120 ms through
Subscriptions, commits title edits immediately, flushes on route exit and
pagehide, and renders saving/saved/error, trashed, missing and sync-rejection
states with retry and restore. `/notes/trash` lists the mirror tombstones and
restores through the `RestoreNote` RPC, because the sync protocol keeps
tombstone-wins: restore refuses offline, refuses while the note still has a
queued outbox entry, merges the returned server row into the mirror, and uses
the legacy offline/queued/failure copy. Every other note write commits the
IndexedDB mirror row and outbox entry together; no other note write uses RPC.
Story and Scene tests cover the update/command paths and the rendered states,
and the body, draft, search and saver cases are ported from the legacy tests.
The screen CSS is in `styles.css`. Parity gaps: the legacy editor hydrated a
note missing from the mirror with `GET note` over RPC; this slice renders the
missing state instead. Ctrl+K focuses the search box but does not select its
text.

**Delivered — Settings:** `src/settings.ts` is the `/settings` password-form
Submodel and `/settings` now composes it between the display-preferences panel
and the push-health panel, matching the legacy order: theme gallery, display
preferences, password, push health. The form keeps the legacy heading and
explanation, the three fields with their labels, autocomplete hints, and the
new-password policy hint, and the same validation order: empty current
password, the twelve-character policy, then the confirmation mismatch. The
`ChangePassword` Command derives both login keys in the browser with
`deriveLoginKey` for the signed-in email and posts them through the existing
plain-HTTP `authApi.changePassword` with `credentials: "include"`; raw
passwords never reach the request. A submit disables the fields and the button
and swaps the button label for the spinner; success clears all three fields and
shows `گذرواژه تغییر کرد.`, failures map through `authErrorMessage`, and the
typed values survive a failed attempt. Leaving the screen clears the form like
the legacy remount, and signing out clears it too. The
settings subtitle now names account security as the legacy route did. Story
tests cover the validation, command, busy, failure, and success transitions;
Scene tests cover the rendered form states; the legacy `passwordProblem` and
auth-client cases remain covered by `login-key.test.ts` and `auth-api.test.ts`.
`/household` onboarding and `/notes/trash` were already delivered in P2.3 and
P2.6, and the legacy `/settings` route exposes no household or trash forms.
Settings is complete; Occasions and Calendar are the remaining P2.6 screens.

## Verification

- Per slice: `pnpm --filter @tali/web-foldkit typecheck|test|lint` plus
  `pnpm --filter @tali/web-foldkit build`.
- Cross-package changes: `pnpm typecheck`, `pnpm build`, `pnpm test` from the
  root before handoff.
- Before retiring `apps/web`: run the `@tali/e2e` gate flows against the
  Foldkit dev server and the local api stack, and record the result in the
  migration issue.
