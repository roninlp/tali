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
  :8787. API proxying and CORS wiring are not part of the scaffold yet.
- **Effect version.** This app pins Effect 4.1, which Foldkit requires. The rest
  of the workspace is still on Effect 4.0.x. Keep the new app on its own
  versions; do not upgrade the whole workspace as part of a migration change
  unless the task asks for it.
- **Phase 1 scope.** The `routing` starter is a working reference for routes,
  Submodels, Commands, and Story/Scene tests. Replacing it with Tali's screens
  is the migration phase, not the scaffold phase.
