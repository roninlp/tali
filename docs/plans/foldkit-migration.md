# Foldkit migration — Phase 2 plan

**Status:** in progress. Phase 1 (scaffold), the Phase 2 prerequisites
(workspace-wide Effect 4.1, api proxy, typed RPC entry point), P2.1 (shell,
theming, RTL document), P2.2 (route union and navigation), P2.3 (auth and
session restore), P2.4 (local store and sync engine), and P2.5 (preferences,
theme, and push) are in place. P2.6 (feature screens) is in progress: Today and
Lists are delivered; Tasks through Settings remain. P2.5's real vendor-push
check is still blocked on a local VAPID pair and a real browser; everything
else is verified.

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
source badge, retry, and save confirmation; the account/password, household,
and trash surfaces remain P2.6 work. Auth stays on plain fetch; the data slices
still use `withRpcClient`.

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
9. Settings, household, trash, and push-health

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

## Verification

- Per slice: `pnpm --filter @tali/web-foldkit typecheck|test|lint` plus
  `pnpm --filter @tali/web-foldkit build`.
- Cross-package changes: `pnpm typecheck`, `pnpm build`, `pnpm test` from the
  root before handoff.
- Before retiring `apps/web`: run the `@tali/e2e` gate flows against the
  Foldkit dev server and the local api stack, and record the result in the
  migration issue.
