# Tali

Personal & family planner / bullet journal — Must MVP.

Monorepo (Vite Task + pnpm workspaces) per `docs/must-have-feature-map.html` §3.
Infrastructure is Alchemy (`alchemy` npm package): one stack owns the D1
database, the api Worker, and the web assets.

## Layout

```
apps/
  web-foldkit/  Foldkit + Effect SPA (Vite on :3001)
  api/          Effect HTTP/RPC server on Cloudflare Workers + D1
packages/
  domain/       @effect/schema entities, invariants, typed errors  (only shared dep)
  sql/          @effect/sql-d1 repositories + D1 migrations
  rpc/          Effect RPC contract (RpcGroup) consumed by web + api
  config/       typed env (Effect Config)
infra/          Alchemy stack — D1 + api Worker + web static assets
```

## Quick start

```sh
pnpm install
pnpm dev              # boots the whole app
```

`pnpm dev` runs `alchemy dev` through Vite Task and brings up the entire stack
locally — no Cloudflare account, no credentials, no `wrangler`:

- **D1** — a local simulator; every migration in `packages/sql/migrations` is
  applied on boot (and on each reconcile).
- **api Worker** — the real Worker bundle running in workerd, bound to that
  database, on <http://localhost:8787> (`/health`, `/auth/*`, `/rpc`, `/sync/*`,
  `/push/*`).
- **web app** — the Foldkit SPA on <http://localhost:3001>, proxying the api
  routes to :8787 so cookies stay same-origin.

Open <http://localhost:3001>, register, create a household, and you are in.
Editing API or web code hot-reloads in place.

To run only the frontend (without the api stack):

```sh
pnpm dev:foldkit      # http://localhost:3001
```

It has its own AI setup: `apps/web-foldkit/FOLDKIT.md`, the vendored Foldkit
source at `repos/foldkit`, Foldkit skills in `.agents/skills/`, and the
DevTools MCP server in `opencode.json`. See `apps/web-foldkit/README.md` for
the app layout.

Local state lives in `infra/.alchemy/`. `rm -rf infra/.alchemy` gives you a
fresh database (migrations re-apply on the next `pnpm dev`).

### Other commands

```sh
pnpm typecheck        # Vite Task typecheck across all packages/apps (includes the Alchemy stack)
pnpm lint             # Oxlint across the repo (root task)
pnpm lint:fix         # apply Oxlint fixes
pnpm format           # Oxfmt check across the repo (root task)
pnpm format:fix       # write Oxfmt changes
pnpm quality          # lint + format check
pnpm test             # Vite Task test (cached)
pnpm build            # Vite Task build (packages typecheck; web: static SPA build)
pnpm stack:plan       # alchemy plan  — diff the Cloudflare stack (needs a profile)
pnpm stack:deploy     # alchemy deploy
pnpm stack:destroy    # alchemy destroy
```

### TypeScript and the Effect language service

The workspace compiler is `@effect/tsgo`: TypeScript 7 with the Effect language
service built in. The root `prepare` script (`effect-tsgo patch`) swaps the
installed compiler for the patched one on every `pnpm install`, so both `tsc`
and the editor's TypeScript server get Effect diagnostics, hover quick-info,
completions and refactors.

- The plugin is enabled once in `@tali/tsconfig` (`base.json` and `web.json`),
  so every project inherits it; `packages/tsconfig/README.md` explains the
  options.
- `pnpm typecheck` prints Effect diagnostics next to TypeScript's. Effect
  suggestions and warnings are advisory — only Effect errors fail the build.
- VS Code / Cursor: `.vscode/settings.json` points the editor at the workspace
  compiler and the native TS server. Accept "Use Workspace Version" if asked,
  and keep this the only TypeScript server in the workspace. Other editors
  should run their TypeScript LSP from the same workspace compiler
  (`node_modules/typescript/bin`).
- Effect *linting* stays with Oxlint: `packages/lint-config/oxlint/effect-typed.ts`
  is the curated rule set that gates `pnpm lint:effect`. The LSP reports the
  broader set in the editor.
- Check a project or file without an editor:

  ```sh
  pnpm exec effect-tsgo diagnostics --project apps/api/tsconfig.json --format text
  pnpm exec effect-tsgo diagnostics --file apps/web-foldkit/src/main.ts --format json
  ```

Package-level dev servers still work on their own when you want one process:
`pnpm --filter @tali/web-foldkit exec vite` (Vite on :3001). Alchemy owns the
API Worker — there is no separate `wrangler dev` path.

Web Push shell (service worker, VAPID subscription, permission panel):

```sh
# see docs/web-push-local.md for VAPID keys + the local test-push script
pnpm test:push
```

## How the stack is wired

`infra/alchemy.run.ts` declares four resources:

| Resource | Local (`alchemy dev`) | Deploy (`alchemy deploy`) |
| --- | --- | --- |
| `TaliDatabase` (D1) | local simulator + migrations | real D1 + migrations |
| `TaliBackups` (R2) | local R2 simulator | private bucket for nightly dumps |
| `TaliApi` (Worker) | workerd on :8787 | uploaded Worker, `DB` + `BACKUP_BUCKET` bindings |
| `TaliWeb` (StaticSite) | `vite` dev server on :3001 | `vite build` → `dist` assets |

The api entry stays a plain `async fetch(request, env)` module: Alchemy binds
`env.DB` as a native `D1Database`, which is what `@effect/sql-d1` already
consumes. State is `localState()` under `.alchemy/state` during dev and
`Cloudflare.state()` when deploying.

The Worker also runs three cron triggers: the per-minute reminder sweep
(ADR-0005), the nightly 30-day trash purge, and the nightly D1 backup to R2.
The last two are decided in ADR-0009; restoring a dump is documented in
`docs/backup-restore.md`.

## The scaffold round-trip (dummy aggregate: `ListItem`)

1. **`packages/domain`** — `ListItem`, `ListItemInsert`, `ListItemNotFound`,
   `Change`/`SyncPullResponse` (sync envelope).
2. **`packages/sql`** — `migrations/0001_list_items.sql` + `ListItemRepo`
   (`@effect/sql-d1` `SqlClient` + `SqlSchema`).
3. **`packages/rpc`** — `ApiRpcs` (`CreateListItem` / `ListListItems` /
   `ToggleListItem`) + derived `ApiClient` type.
4. **`apps/api`** — `ListService` layer → RPC handlers → `RpcServer.layerHttp`
   at `/rpc`; plain-HTTP `/sync/pull`; served as a Cloudflare Worker via
   `HttpRouter.toWebHandler` + `D1Client.layer`.
5. **`apps/web-foldkit`** — Foldkit shell; the browser calls a derived
   `RpcClient` (`effect/rpc` + `FetchHttpClient`) over HTTP directly at `/rpc`.

Migrations are applied by Alchemy (deploy) and by the local D1 provider (dev),
because D1 has no interactive transactions and Effect's `Migrator` cannot run on
it (see `docs/research/effect-drizzle-d1.md`).
