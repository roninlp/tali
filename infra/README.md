# infra — Alchemy

The Tali stack as typed TypeScript. `alchemy.run.ts` declares three resources and
is the single owner of how the app runs:

| Resource | Type | Local (`alchemy dev`) | Deploy |
| --- | --- | --- | --- |
| `TaliDatabase` | `Cloudflare.D1.Database` | local simulator; `packages/sql/migrations` applied on every reconcile | real D1; migrations applied on deploy |
| `TaliApi` | `Cloudflare.Worker` | `apps/api/src/index.ts` in workerd on :8787 | uploaded Worker with the `DB` binding |
| `TaliWeb` | `Cloudflare.Website.StaticSite` | `pnpm run dev` (Vite) on :3000 | `pnpm run build` → `apps/web/dist/client` as static assets |

## Run it

From the repo root:

```sh
pnpm dev              # turbo → alchemy dev (whole app, no Cloudflare account)
```

Or directly:

```sh
cd infra
pnpm dev              # alchemy dev
```

Everything is local: the D1 simulator and workers' storage live under
`infra/.alchemy/`, and dev state is written with `localState()` (no Cloudflare
state store to bootstrap). Delete `.alchemy/` to start from an empty database;
migrations re-apply on the next boot.

Ports are pinned and `strictPort`-protected because the app hard-codes them:
api `:8787` (the web app's `API_URL`, and the origin the api accepts preflighted
requests from) and web `:3000` (the api's `DEV_ORIGIN`).

## Deploy

Deploying needs Cloudflare credentials in an Alchemy profile
(`~/.alchemy/profiles.json`); state then switches to `Cloudflare.state()`.

```sh
pnpm stack:plan       # alchemy plan   (diff)
pnpm stack:deploy     # alchemy deploy
pnpm stack:destroy    # alchemy destroy
```

Stages isolate environments (`alchemy deploy --stage prod`), and every stage is
an instance of the same program.

## Notes

- Paths in `alchemy.run.ts` resolve from the file, not the working directory, so
  the stack works under Turbo (`infra/`) or from the repo root with
  `--config infra/alchemy.run.ts`.
- The api is an **async Worker** (plain `{ fetch }` module), not an
  Effect-native one: the app already builds its Effect layer per request around
  `env.DB`, and `InferEnv` types the binding as `D1Database`.
- `alchemy dev` requires `@effect/platform-node` next to `alchemy` (peer
  dependency of the CLI).
- If a resource ever has no local provider, `alchemy dev` deploys it live into
  your personal `dev_$USER` stage — separate from anything `alchemy deploy` owns.
