# @tali/web-foldkit

Tali's next frontend, built with [Foldkit](https://foldkit.dev) — the Elm
Architecture on Effect — plus Vite and Tailwind CSS v4.

This is the phase-1 scaffold. The legacy Solid app at `apps/web` stays in the
repo as the behavioral reference until the migration is complete.

## Run it

From the repo root:

```sh
pnpm install
pnpm --filter @tali/web-foldkit dev   # http://localhost:3001
```

`pnpm dev:foldkit` is the shorthand. The port is pinned in `vite.config.ts`
because the legacy app owns :3000 and the api Worker owns :8787.

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

## Structure

```
src/entry.ts       Runtime bootstrap (Runtime.makeApplication + Runtime.run)
src/main.ts        Model, Messages, init, update, view, subscriptions
src/route.ts       Route union and URL parser
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
