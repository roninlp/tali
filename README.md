# Tali

Personal & family planner / bullet journal — Must MVP.

Monorepo (Turborepo + pnpm workspaces) per `docs/must-have-feature-map.html` §3.

## Layout

```
apps/
  web/          SolidStart (SolidJS + Vite) client + SSR shell
  api/          Effect HTTP/RPC server on Cloudflare Workers + D1
packages/
  domain/       @effect/schema entities, invariants, typed errors  (only shared dep)
  sql/          @effect/sql-d1 repositories + D1 migrations
  rpc/          Effect RPC contract (RpcGroup) consumed by web + api
  config/       typed env (Effect Config)
  ui/           Solid design-system components + tokens
infra/          Alchemy v2 stacks (D1 + Worker binding)
```

## Quick start

```sh
pnpm install
pnpm typecheck        # turbo typecheck across all packages/apps
pnpm build            # turbo build (api/domain/... typecheck; web: srvx build)
```

Run the api locally (D1 + migrations):

```sh
cd apps/api
pnpm wrangler d1 migrations apply DB --local
pnpm dev              # wrangler dev (serves /rpc, /sync/pull, /health)
```

Run the web app:

```sh
cd apps/web
pnpm dev              # Vite dev server on :3000
```

Web Push shell (service worker, VAPID subscription, permission panel):

```sh
# see docs/web-push-local.md for VAPID keys + the local test-push script
pnpm test:push
```

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
5. **`apps/web`** — SolidStart shell; `"use server"` functions in
   `src/server/list-items.ts` build a derived `RpcClient` over the same contract.

Migrations are applied out-of-band (`wrangler d1 migrations apply` or Alchemy),
because D1 has no interactive transactions and Effect's `Migrator` cannot run on
it (see `docs/research/effect-drizzle-d1.md`).
