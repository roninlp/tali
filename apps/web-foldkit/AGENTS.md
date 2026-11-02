# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: true

## Project Notes

- **Monorepo location.** This package is `apps/web-foldkit` in the Tali pnpm +
  Turbo workspace. Run scripts from the repo root with
  `pnpm --filter @tali/web-foldkit <script>`, or from this directory.
- **Vendored Foldkit source.** The Foldkit repository is vendored at the repo
  root as `../../repos/foldkit`, pinned to the installed release. `FOLDKIT.md`
  refers to `./repos/foldkit`; in this monorepo resolve that path to
  `../../repos/foldkit`. Treat the subtree as read-only reference: imports come
  from the `foldkit` npm package, never from the subtree.
- **Agent skills.** The `foldkit`, `generate-program`, and `audit-program`
  skills are linked at the repo root in `.agents/skills/`.
- **Ports.** This app's Vite dev server is pinned to `http://localhost:3001`
  with `strictPort`. The api Worker owns :8787. `pnpm dev` from the repo root
  runs the whole stack; `pnpm dev:foldkit` runs only this app.
- **API access.** Vite proxies `/auth`, `/health`, `/household`, `/month`,
  `/preferences`, `/push`, `/reminders`, `/rpc`, `/search`, `/sync`, `/today`,
  and `/week` to the api Worker on :8787, so the browser stays on :3001 and
  cookies stay same-origin. `/today` is both the dashboard route and its
  read-model endpoint, so it uses the same document bypass as `/household`.
  `/household`, `/push-health`, and `/reminders` are also SPA routes whose
  prefixes belong to the Worker, so the proxy lets browser navigations return
  `index.html` and proxies only API calls. `src/lib/config.ts` resolves the
  base URL and `src/lib/rpc.ts` builds the typed `@tali/rpc` client. Deploys
  use `VITE_API_URL=/api` and the `/api/*` service-binding hop.
- **Effect version.** This app uses Effect 4.1, which Foldkit requires; the
  whole workspace now runs 4.1 through the pnpm catalog. Shared dependency
  versions live in `pnpm-workspace.yaml` and are referenced as `catalog:` in
  package manifests, so bump them there rather than in this package alone.
  `vite.config.ts` keeps `effect/schema` out of the dev dependency optimizer:
  bundling `effect` and `effect/schema` as separate entries crashes the
  optimizer in Vite 8.3.4.
- **Frontend layout.** `src/shell.ts` holds the chrome plus the desktop section
  menu, mobile tab bar, display name, and account slot; `src/theme.ts` the
  persistent gallery + light/dark/system
  Submodel; `src/route.ts` the `AppRoute` union and typed routers; `src/auth.ts`
  the session Submodel with restore, sign-out, and cache Commands;
  `src/guard.ts` the guest/session/household access rules;
  `src/preferences.ts` the server-of-record display preferences with their
  synchronous local cache; `src/settings.ts` the Settings password form with its
  browser-side key derivation; `src/push.ts` the Web Push subscription,
  permission, and notification-action Submodel; `src/page/` the login,
  register, household, today, lists, tasks, habits, notes, reminders, and
  calendar screens; and
  `src/sync.ts` the local-first sync Submodel with its managed IndexedDB
  mirror, engine Commands, cadence Subscription, and live mirror snapshot.
  `src/mirror.ts` projects the mirrored Task, Project, Tag, Note, Habit,
  HabitEntry, List, ListItem, Event, and Occasion rows the feature screens
  read (plus the Event/Occasion trash tombstones the calendar overlays);
  `src/habits-model.ts` holds the streak/rate/copy projection plus the habit
  form presets and monthly heatmap; `src/lists-model.ts` the List/ListItem
  ordering, summaries, and pending-key projection; `src/page/today-model.ts`
  and `today-view.ts` hold the dashboard's pure aggregation and view;
  `src/page/lists.ts`, `lists-view.ts`, and `list-view.ts` hold the
  index/detail Submodel and its views; `src/page/tasks-model.ts`,
  `tasks-view.ts`, and `tasks-view-cache.ts` hold the board's
  grouping/filters, view, and per-user saved filter/sort state;
  `src/page/habits.ts`, `habits-view.ts`, and `habits-heatmap-view.ts` hold
  the habits Submodel, its form/list view, and the monthly heatmap;
  `src/page/notes.ts`, `notes-view.ts`, `note-view.ts`, and
  `notes-trash-view.ts` hold the notes index/editor/trash Submodel and views,
  with `src/page/notes-model.ts` carrying the section ordering, tag filter,
  trash order, and pending-note projection; `src/page/reminders.ts`,
  `reminders-view.ts`, and `reminders-model.ts` hold the ledger inbox Submodel,
  its panel, and its copy/formatting; `src/page/calendar.ts`,
  `calendar-view.ts`, and `calendar-model.ts` hold the week/month Submodel, its
  grid/planning/event/occasion views, and the Jalali/source/overlay projection;
  the client pieces are `src/lib/today-api.ts`, `task-writes.ts`,
  `habit-log.ts`, `habit-writes.ts`, `note-body.ts`, `note-draft.ts`,
  `note-search.ts`, `note-search-api.ts`, `note-writes.ts`, `list-writes.ts`,
  `calendar-data.ts`, `calendar-api.ts`, `event-writes.ts`,
  `occasion-writes.ts`, and `reminders/api.ts`. `/settings`
  renders `src/preferences.ts`'s display form, `src/settings.ts`'s password
  form, the theme gallery, and the push health panel. All feature screens are
  delivered.
  `src/session.ts`, `src/household-summary.ts`, and `src/preferences-model.ts`
  hold the plain Model projections the auth/preferences responses decode into,
  so no branded domain value crosses the dev optimizer's `effect/schema`
  boundary. Auth HTTP stays on the plain `fetch` shape with
  `credentials: "include"` because the session cookie is set by the raw
  response; the data slices use `withRpcClient`. The framework-free client core
  lives in `packages/sync-client` (`@tali/sync-client`): the IndexedDB store,
  sync engine, cadence table, and task projection. `@tali/conflict-lab` imports
  that core, so the two-device convergence suite runs against the same engine
  as the Foldkit app.
- **Theme boot.** `public/theme-boot.js` is loaded in `index.html`'s head and
  applies `tali.theme` / `tali.mode` to `<html data-theme>` before first paint;
  `src/theme.ts` starts from the same values in `entry.ts` flags, so a saved
  dark or gallery theme never flashes the light palette.
- **Push and service-worker scope.** `public/sw.js`,
  `manifest.webmanifest`, and the icons are the app's public assets. The worker
  registers at `/sw.js` with scope `/`. The worker receives the API origin from
  the page so a Done/Snooze tap can flush through the Vite proxy (`/reminders`)
  in dev and the `/api` service-binding hop in production. Keep
  `src/lib/push/notification-actions.ts` and `public/sw.js` in sync.
- **Sync smoke check.** With `pnpm dev` running (the api Worker and the app),
  `pnpm test:smoke:foldkit:sync` registers a fresh account,
  creates a household, writes a task online, switches the app to its offline
  state, writes a second task, reloads twice, reconnects, checks both rows on
  the server's pull feed, and signs a second device in to prove convergence.
  The run cuts `/auth`, `/sync/*`, and `/rpc` while keeping Vite's module URLs
  untouched. It uses the local development database and does not reset it.
- **Auth smoke check.** With `pnpm dev` running, `pnpm test:smoke:foldkit`
  registers a fresh account through the :3001 proxy, creates a household,
  reloads into `/today`, signs out, logs back in, and checks the guard
  redirects for signed-out, household, and no-household accounts. It uses the
  local development database and does not reset it.
- **Push check.** `/settings` and `/push-health` show the device's VAPID,
  permission, subscription, and last-action state. The local stack needs
  `VAPID_PRIVATE_KEY` exported before `pnpm dev` to enable a real subscription
  and `pnpm test:push`; without it the panel correctly says the key is
  unconfigured and the enable button is disabled. See
  `../../docs/web-push-local.md`.
- **Dev stack and Effect 4.1.** `alchemy` 2.0.0-beta.83 predates Effect 4.1
  and imports the removed `effect/Crypto` module. `infra` carries a pnpm patch
  (a backport of upstream `alchemy-run/alchemy#2754`) that moves alchemy to
  `effect/crypto/Digest` and `effect/crypto/SecureRandom`, so the api Worker
  boots from a clean install with no `node_modules` shim. The Foldkit app was
  unaffected. Drop the patch once a published alchemy release includes the fix;
  see `../../infra/README.md`.
- **Styling.** `src/styles.css` holds only the design tokens and primitives;
  screens style themselves with Tailwind utilities at the call site. The house
  light/dark tokens live in its `@theme` block and are overridden under
  `[data-theme='talidark']` (utilities compile to `var()` references, so
  runtime theme switching works). The `@layer components` section is limited
  to the shells `@foldkit/ui` components render through their `toView`
  callbacks (`btn`, `badge`, `spinner`, `notice`, `field-input`, `float-card`,
  `menu-*`, `listbox-*`, `app-modal*`, `toast-*`, `segmented`, `form-check`)
  plus the `page-wrap`, `panel`, `soft-note`, and `section-head` utilities.
  Page-level styling never goes back into `styles.css`. Interactive behaviour
  and ARIA come from `@foldkit/ui` components (`Button`, `Input`, `Listbox`,
  `Menu`, `Popover`, `Dialog`, `Toast`, `RadioGroup`, `Nav`). Vazirmatn ships
  in `src/fonts/` with its OFL licence and Vite fingerprints it on build. The
  theme toggle is device-local and restores from `public/theme-boot.js`, which
  accepts only the two house theme ids, before first paint.
- **Migration record.** The completed Phase 2 slices and acceptance criteria
  live in `../../docs/plans/foldkit-migration.md`. Keep this file's notes
  project-specific.
