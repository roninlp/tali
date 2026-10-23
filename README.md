# Tali

Personal & family planner / bullet journal — Must MVP.

Monorepo (Turborepo + pnpm workspaces) per `docs/must-have-feature-map.html` §3.
Infrastructure is Alchemy (`alchemy` npm package): one stack owns the D1
database, the api Worker, and the web assets.

## Layout

```
apps/
  web/          Solid v2 (client-only, Vite) SPA — RTL Persian shell
  api/          Effect HTTP/RPC server on Cloudflare Workers + D1
packages/
  domain/       @effect/schema entities, invariants, typed errors  (only shared dep)
  sql/          @effect/sql-d1 repositories + D1 migrations
  rpc/          Effect RPC contract (RpcGroup) consumed by web + api
  config/       typed env (Effect Config)
  ui/           Solid design-system components + tokens
infra/          Alchemy stack — D1 + api Worker + web static assets
```

## Quick start

```sh
pnpm install
pnpm dev              # boots the whole app
```

`pnpm dev` runs `alchemy dev` through Turbo and brings up the entire stack
locally — no Cloudflare account, no credentials, no `wrangler`:

- **D1** — a local simulator; every migration in `packages/sql/migrations` is
  applied on boot (and on each reconcile).
- **api Worker** — the real Worker bundle running in workerd, bound to that
  database, on <http://localhost:8787> (`/health`, `/auth/*`, `/rpc`, `/sync/*`,
  `/push/*`).
- **web app** — Vite dev server with HMR on <http://localhost:3000>, allowed to
  call the api cross-origin (session cookie included).

Open <http://localhost:3000>, register, create a household, and you are in.
Editing API or web code hot-reloads in place.

Local state lives in `infra/.alchemy/`. `rm -rf infra/.alchemy` gives you a
fresh database (migrations re-apply on the next `pnpm dev`).

### Other commands

```sh
pnpm typecheck        # turbo typecheck across all packages/apps (includes the Alchemy stack)
pnpm test             # turbo test
pnpm build            # turbo build (packages typecheck; web: static SPA build)

pnpm stack:plan       # alchemy plan  — diff the Cloudflare stack (needs a profile)
pnpm stack:deploy     # alchemy deploy
pnpm stack:destroy    # alchemy destroy
```

Package-level dev servers still work on their own when you want one process:
`pnpm --filter @tali/web exec vite` (Vite on :3000). Alchemy owns the API
Worker — there is no separate `wrangler dev` path.

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
| `TaliWeb` (StaticSite) | `vite` dev server on :3000 | `vite build` → `dist/client` assets |

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
4. **`apps/api`** — `ListItemService` layer → RPC handlers → `RpcServer.layerHttp`
   at `/rpc`; plain-HTTP `/sync/pull`; served as a Cloudflare Worker via
   `HttpRouter.toWebHandler` + `D1Client.layer`.
5. **`apps/web`** — Solid v2 shell; the browser calls a derived `RpcClient`
   (`effect/rpc` + `FetchHttpClient`) over HTTP directly at `/rpc`.

Migrations are applied by Alchemy (deploy) and by the local D1 provider (dev),
because D1 has no interactive transactions and Effect's `Migrator` cannot run on
it (see `docs/research/effect-drizzle-d1.md`).
