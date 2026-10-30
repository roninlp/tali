# @tali/web-foldkit

Tali's next frontend, built with [Foldkit](https://foldkit.dev) — the Elm
Architecture on Effect — plus Vite and Tailwind CSS v4.

This is the phase-1 scaffold. The legacy Solid app at `apps/web` stays in the
repo as the behavioral reference until the migration is complete.

## Run it

From the repo root:

```sh
pnpm install
pnpm dev              # full stack; this app comes up on http://localhost:3001
```

For frontend-only work, run this app on its own:

```sh
pnpm dev:foldkit      # http://localhost:3001
```

The port is pinned in `vite.config.ts` because the legacy app owns :3000 and
the api Worker owns :8787. The dev server proxies the api Worker's routes to
:8787, so auth and sync need the full `pnpm dev` stack (or a separately
running api Worker).

Other scripts:

```sh
pnpm --filter @tali/web-foldkit typecheck
pnpm --filter @tali/web-foldkit test
pnpm --filter @tali/web-foldkit build
pnpm --filter @tali/web-foldkit lint
pnpm --filter @tali/web-foldkit format
```

## AI-assisted development

- `FOLDKIT.md` — Foldkit's framework conventions. Foldkit owns it and replaces
  it whole on upgrade, so project-specific notes live in `AGENTS.md`.
- `AGENTS.md` — this package's notes for coding agents.
- `../../repos/foldkit` — the Foldkit repository vendored as a git subtree,
  pinned to the installed release. Read-only reference: examples, framework
  source, the docs site, and the production apps. Never import from it.
- `../../.agents/skills/` — the `foldkit`, `generate-program`, and
  `audit-program` skills, linked from the vendored repository.
- DevTools MCP — `.mcp.json` covers agents that read that format; the root
  `opencode.json` registers `foldkit-devtools` for OpenCode. With `pnpm dev`
  running and the app open in a browser, agents can inspect the Model, Message
  history, and replay state.

## Migration status

- [x] **Phase 1 — scaffold.** Official `create-foldkit-app` starter, workspace
  integration, pinned dev port, vendored Foldkit source, agent skills, DevTools
  MCP, and root agent docs.
- [x] **Phase 2 prerequisites.** Shared versions live in the pnpm catalog and
  the whole workspace runs Effect 4.1, so `@tali/domain` and `@tali/rpc`
  resolve to one Effect instance. Vite proxies the api Worker's routes to
  `:8787`, and `src/lib/{config,rpc}.ts` provide the typed client the port
  will use.
- [ ] **Phase 2 — port the app.** Shell/theming, routing union, auth and
  session restore, local store and sync engine, preferences/push, then the
  feature screens (today, tasks, lists, habits, notes, occasions, calendar,
  reminders, settings). The ordered slices and acceptance criteria live in
  [`docs/plans/foldkit-migration.md`](../../docs/plans/foldkit-migration.md).

`apps/web` is the source of truth for behavior until Phase 2 is finished. The
routing starter's `People` page, `fileTree` routes, and their tests are
reference material for Foldkit patterns; they are expected to be replaced.

## Structure

```
src/entry.ts       Runtime bootstrap (Runtime.makeApplication + Runtime.run)
src/main.ts        Model, Messages, init, update, view, subscriptions
src/route.ts       Route union and URL parser
src/lib/config.ts  API base URL (dev proxy vs deployed /api)
src/lib/rpc.ts     Typed RPC client over the api Worker's contract
src/page/          Submodels (the routing starter's People page)
```

The runtime stays separate from the pure definitions, so tests can import the
application without booting a browser runtime.

## Scaffold provenance

Generated with:

```sh
npx create-foldkit-app@latest \
  --name web-foldkit \
  --rendering spa \
  --example routing \
  --package-manager pnpm
```

Foldkit 0.170.0 / Effect 4.1.0, then adapted to the Tali pnpm + Turbo workspace
(package name, pinned dev port, no nested lockfile or workspace file).
