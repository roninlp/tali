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
  :3001 and cookies stay same-origin. `src/lib/config.ts` resolves the base
  URL and `src/lib/rpc.ts` builds the typed `@tali/rpc` client; both are
  ports of the legacy app's `lib/config.ts` and `lib/rpc.ts`. Deploys use
  `VITE_API_URL=/api` and the `/api/*` service-binding hop.
- **Effect version.** This app uses Effect 4.1, which Foldkit requires; the
  whole workspace now runs 4.1 through the pnpm catalog. Shared dependency
  versions live in `pnpm-workspace.yaml` and are referenced as `catalog:` in
  package manifests, so bump them there rather than in this package alone.
- **Migration progress.** P2.1 (shell, theming, RTL document) is in place: the
  starter is gone, `src/shell.ts` holds the chrome, `src/theme.ts` the house
  light/dark Submodel, and `src/ui/` the button and field primitives. P2.2 adds
  the route union and navigation.
- **Styling.** `src/styles.css` is the Tali entry: Tailwind v4 + daisyUI, the
  `tali`/`talidark` themes, and the shared utilities. Vazirmatn stays in
  `@tali/ui`; the CSS references it across the workspace and Vite fingerprints
  it on build. The theme toggle is in-session only until P2.5 adds the saved
  preference and pre-paint restore.
- **Migration plan.** The ordered Phase 2 slices and acceptance criteria live
  in `../../docs/plans/foldkit-migration.md`. Read it before picking up the
  next slice; keep this file's notes project-specific.
