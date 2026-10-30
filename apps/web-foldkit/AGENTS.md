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
- **Legacy app.** `apps/web` is the Solid v2 app and remains the behavioral
  reference until the migration is complete. Do not edit it during migration
  work unless the task says so; port behavior from it instead.
- **Ports.** This app's Vite dev server is pinned to `http://localhost:3001`
  with `strictPort`. The legacy web app owns :3000 and the api Worker owns
  :8787. `pnpm dev` from the repo root runs all three; `pnpm dev:foldkit` runs
  only this app.
- **API access.** Vite proxies `/auth`, `/health`, `/household`, `/push`,
  `/rpc`, and `/sync` to the api Worker on :8787, so the browser stays on
  :3001 and cookies stay same-origin. `/household` and `/push-health` are also
  SPA routes that share two of those prefixes, so the proxy lets browser
  navigations return `index.html` and proxies only API calls. `src/lib/config.ts`
  resolves the base URL and `src/lib/rpc.ts` builds the typed `@tali/rpc`
  client; both are ports of the legacy app's `lib/config.ts` and `lib/rpc.ts`.
  Deploys use `VITE_API_URL=/api` and the `/api/*` service-binding hop.
- **Effect version.** This app uses Effect 4.1, which Foldkit requires; the
  whole workspace now runs 4.1 through the pnpm catalog. Shared dependency
  versions live in `pnpm-workspace.yaml` and are referenced as `catalog:` in
  package manifests, so bump them there rather than in this package alone.
  `vite.config.ts` keeps `effect/schema` out of the dev dependency optimizer:
  bundling `effect` and `effect/schema` as separate entries crashes the
  optimizer in Vite 8.3.4.
- **Migration progress.** P2.1 (shell, theming, RTL document), P2.2 (route
  union and navigation), P2.3 (auth and session restore), and P2.4 (local
  store and sync engine) are in place: `src/shell.ts` holds the chrome plus the
  desktop section menu, mobile tab bar, display name, and account slot;
  `src/theme.ts` the house light/dark Submodel; `src/route.ts` the `AppRoute`
  union and typed routers; `src/auth.ts` the session Submodel with restore,
  sign-out, and cache Commands; `src/guard.ts` the guest/session/household
  access rules; `src/page/` the login, register, and household screens; and
  `src/sync.ts` the local-first sync Submodel with its managed IndexedDB
  mirror, engine Commands, cadence Subscription, and quick-add snapshot.
  `src/session.ts` and `src/household-summary.ts` hold the plain Model
  projections the auth responses decode into, so no branded domain value
  crosses the dev optimizer's `effect/schema` boundary. Auth HTTP stays on the
  legacy `fetch` shape with `credentials: "include"` because the session cookie
  is set by the raw response; the data slices use `withRpcClient`. The
  framework-free client core lives in `packages/sync-client`
  (`@tali/sync-client`): the IndexedDB store, sync engine, cadence table, and
  task projection. `@tali/conflict-lab` imports that core, so the two-device
  convergence suite runs against the same engine as the Foldkit app. P2.5
  adds preferences, saved theme, and push.
- **Sync smoke check.** With `pnpm dev` running (the api Worker and both
  frontends), `pnpm test:smoke:foldkit:sync` registers a fresh account,
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
- **Dev stack and Effect 4.1.** `alchemy` 2.0.0-beta.83 predates Effect 4.1
  and imports the removed `effect/Crypto` module. `infra` carries a pnpm patch
  (a backport of upstream `alchemy-run/alchemy#2754`) that moves alchemy to
  `effect/crypto/Digest` and `effect/crypto/SecureRandom`, so the api Worker
  boots from a clean install with no `node_modules` shim. The Foldkit app was
  unaffected. Drop the patch once a published alchemy release includes the fix;
  see `../../infra/README.md`.
- **Styling.** `src/styles.css` is the Tali entry: Tailwind v4 + daisyUI, the
  `tali`/`talidark` themes, and the shared utilities. Vazirmatn stays in
  `@tali/ui`; the CSS references it across the workspace and Vite fingerprints
  it on build. The theme toggle is in-session only until P2.5 adds the saved
  preference and pre-paint restore.
- **Migration plan.** The ordered Phase 2 slices and acceptance criteria live
  in `../../docs/plans/foldkit-migration.md`. Read it before picking up the
  next slice; keep this file's notes project-specific.
