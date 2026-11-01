# infra — Alchemy

The Tali stack as typed TypeScript. `alchemy.run.ts` declares four resources and
is the single owner of how the app runs:

| Resource | Type | Local (`alchemy dev`) | Deploy |
| --- | --- | --- | --- |
| `TaliDatabase` | `Cloudflare.D1.Database` | local simulator; `packages/sql/migrations` applied on every reconcile | real D1; migrations applied on deploy |
| `TaliBackups` | `Cloudflare.R2.Bucket` | local R2 simulator | private R2 bucket; nightly D1 dumps, 30-day lifecycle safety net |
| `TaliApi` | `Cloudflare.Worker` | `apps/api/src/index.ts` in workerd on :8787 | uploaded Worker with the `DB` + `BACKUP_BUCKET` bindings |
| `TaliWeb` | `Cloudflare.Website.StaticSite` | `pnpm run dev` (Vite) on :3001 | `pnpm run build` → `apps/web-foldkit/dist` as static assets, with `apps/web-foldkit/worker.ts` in front of them |

The api Worker declares **three** cron triggers:

- `* * * * *` — the reminder sweep (ADR-0005);
- `17 3 * * *` — the 30-day trash purge (#85);
- `47 3 * * *` — the nightly D1 backup to `TaliBackups` (#85).

`alchemy dev` runs its own cron timer at the matching minute; a specific tick can
also be driven by hand at `POST /cdn-cgi/handler/scheduled?cron=<expression>&time=<epoch-ms>`.
The dev-only reminder trigger `POST /dev/reminders/sweep?at=<ISO>` is unchanged.
The purge and backup decisions are in ADR-0009; the restore runbook is
`docs/backup-restore.md`.

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
api `:8787` (the web app's proxy target, and the origin the api accepts
preflighted requests from) and web `:3001` (the api's `DEV_ORIGIN`).

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

The deploy puts the SPA and the api Worker on **one origin**: `/api/*` is
routed worker-first into `apps/web-foldkit/worker.ts`, which strips the prefix
and forwards over the `API` service binding. The session cookie stays
same-origin, and the client is built with `VITE_API_URL=/api`, resolved against
the page origin at runtime — the same build works on any stage URL or custom
domain.

An environment without R2 (R2 has to be enabled in the dashboard first) deploys
with `TALI_BACKUPS=off`: no bucket, no `BACKUP_BUCKET` binding and no nightly
backup trigger. The purge and reminder triggers are unaffected.

A deploy also needs the Web Push identity: `VAPID_PRIVATE_KEY` (a Workers
**secret**) and `VAPID_SUBJECT` (a real `mailto:`/`https:` URI). Generate a pair
with `pnpm exec web-push generate-vapid-keys`; no key pair is committed to this
repository. Without them the deploy fails instead of shipping an inbox-only app.
`alchemy dev` reads the shell environment, not `.dev.vars`, so export the key
before `pnpm dev`. See `docs/web-push-local.md` §1.

## Notes

- Paths in `alchemy.run.ts` resolve from the file, not the working directory, so
  the stack works under Turbo (`infra/`) or from the repo root with
  `--config infra/alchemy.run.ts`.
- The api is an **async Worker** (plain `{ fetch }` module), not an
  Effect-native one: the app already builds its Effect layer per request around
  `env.DB`, and `InferEnv` types the binding as `D1Database`.
- `alchemy dev` requires `@effect/platform-node` next to `alchemy` (peer
  dependency of the CLI).
- **Effect 4.1 patch.** `alchemy` 2.0.0-beta.83 was built against Effect 4.0
  and imports `effect/Crypto`, which Effect 4.1 replaced with
  `effect/crypto/Digest` and `effect/crypto/SecureRandom`.
  `pnpm-workspace.yaml` applies `patches/alchemy@2.0.0-beta.83.patch`, a backport
  of upstream's `fix: support effect 4.1` (`alchemy-run/alchemy#2754`,
  commit `9d0709d`) covering the runtime `lib/` output, the `src` Bun entry, and
  the affected type declarations. No `node_modules` shim is needed. The fix
  landed after 2.0.0-beta.84, so drop the patch once a published alchemy release
  contains it: bump `alchemy`, delete the patch, and remove its
  `patchedDependencies` entry.
- If a resource ever has no local provider, `alchemy dev` deploys it live into
  your personal `dev_$USER` stage — separate from anything `alchemy deploy` owns.
