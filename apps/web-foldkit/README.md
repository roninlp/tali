# @tali/web-foldkit

Tali's frontend, built with [Foldkit](https://foldkit.dev) — the Elm
Architecture on Effect — plus Vite and Tailwind CSS v4.

The app is the single web client: the shell, the RTL document, the local-first
sync engine, and every feature screen live here.

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

The port is pinned in `vite.config.ts`; the api Worker owns :8787. The dev
server proxies the api Worker's routes to :8787, so auth and sync need the full
`pnpm dev` stack (or a separately running api Worker).

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

The Foldkit migration is complete and the legacy Solid app has been retired.
Every slice below is delivered and covered by Story/Scene tests:

- [x] **Phase 1 — scaffold.** Official `create-foldkit-app` starter, workspace
      integration, pinned dev port, vendored Foldkit source, agent skills, DevTools
      MCP, and root agent docs.
- [x] **Phase 2 prerequisites.** Shared versions live in the pnpm catalog and
      the whole workspace runs Effect 4.1, so `@tali/domain` and `@tali/rpc`
      resolve to one Effect instance. Vite proxies the api Worker's routes to
      `:8787`, and `src/lib/{config,rpc}.ts` provide the typed client.
- [x] **P2.1 — shell, theming, RTL document.**
- [x] **P2.2 — route union and navigation.**
- [x] **P2.3 — auth and session restore.**
- [x] **P2.4 — local store and sync engine.**
- [x] **P2.5 — preferences, saved theme, and push.**
- [x] **P2.6 — Today, Lists, Tasks, Habits, Notes, Reminders, Settings, and
      Calendar (with the Occasions panel).**

The slice record and acceptance criteria live in
[`docs/plans/foldkit-migration.md`](../../docs/plans/foldkit-migration.md).

## Structure

```
src/entry.ts       Runtime bootstrap (Runtime.makeApplication + Runtime.run)
src/main.ts        Model, Message, init, update, view
src/shell.ts       The app chrome (header, action slot, main)
src/theme.ts       House light/dark theme Submodel and toggle
src/ui/            Button, field and icon primitives
src/fonts/         Self-hosted Vazirmatn and its OFL licence
src/styles.css     Tailwind v4 + daisyUI themes and Tali utilities
src/lib/config.ts  API base URL (dev proxy vs deployed /api)
src/lib/rpc.ts     Typed RPC client over the api Worker's contract
worker.ts          Deployed Worker: serves the assets and proxies /api/*
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
