# Foldkit migration — Phase 2 plan

**Status:** in progress. Phase 1 (scaffold), the Phase 2 prerequisites
(workspace-wide Effect 4.1, api proxy, typed RPC entry point), and P2.1
(shell, theming, RTL document) are in place. P2.2 (route union and navigation)
is next.

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
| `src/lib/local-store/store.ts` | local store service | Keep IndexedDB behind a thin service; Model stores snapshots |
| `src/lib/sync-engine.ts`, `sync-cadence.ts` | Commands + Subscriptions | Pure logic is reusable; drive it from Foldkit Commands |
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

### P2.5 — Preferences, theme, and push

- Port preferences (server-of-record + local cache; ADR-0002) into Model +
  Commands; restore the theme before first paint.
- Port `lib/push/*` (VAPID config, subscribe/unsubscribe, notification actions,
  service worker) and the push-health screen.
- Decide the service-worker scope for :3001 and document it; keep the legacy
  `apps/web` worker untouched.

**Done when:** theme survives reload; a test notification from
`pnpm test:push` opens the right screen; preference changes round-trip.

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

## Verification

- Per slice: `pnpm --filter @tali/web-foldkit typecheck|test|lint` plus
  `pnpm --filter @tali/web-foldkit build`.
- Cross-package changes: `pnpm typecheck`, `pnpm build`, `pnpm test` from the
  root before handoff.
- Before retiring `apps/web`: run the `@tali/e2e` gate flows against the
  Foldkit dev server and the local api stack, and record the result in the
  migration issue.
