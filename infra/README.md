# infra — Alchemy

The Tali stack as typed TypeScript. `alchemy.run.ts` declares four base
resources, plus opt-in OTLP destinations (see Observability), and is the single
owner of how the app runs:

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

The deploy command is `pnpm stack:deploy` (`turbo run deploy` → `alchemy deploy`).
It reads its credentials from the process environment; none of them live in the
repository:

| Variable | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts, D1 and Workers R2 Storage edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | the target account |
| `VAPID_PRIVATE_KEY` | the existing Web Push identity (base64url) |
| `VAPID_PUBLIC_KEY` | optional; derived from the private key when omitted |
| `VAPID_SUBJECT` | a real `mailto:`/`https:` contact URI |
| `OPENCODE_API_KEY` | an OpenCode Go key for Capture; without it the feature is inert |
| `CAPTURE_BASE_URL` | optional; the Go OpenAI-compatible root (defaults in code) |
| `CAPTURE_MODEL` | optional; the paid model id (defaults in code) |
| `TALI_BACKUPS` | `off` deploys without R2/backups (default on) |

**Why it used to fail out of the box.** Three separate things:

- Turbo 2 runs tasks in strict env mode, so credentials exported in the shell
  never reached the task. `deploy`, `plan`, `destroy` and `dev` now list the
  variables above in `turbo.json`'s `passThroughEnv`.
- The deploy tasks now load a repository-root `.env` when one exists (the
  package scripts `set -a` it before Alchemy runs), so no manual `export` is
  needed locally.
- The deploy is deliberately fail-fast: without the VAPID identity or without
  Cloudflare credentials (an Alchemy profile, or `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`) it stops instead of shipping an inbox-only app or
  targeting the wrong account.

**Stage.** Alchemy defaults the stage to `live_${USER}`. Pin it so a laptop, CI
and every future operator target the same environment:

```sh
export ALCHEMY_STAGE=demo
```

Locally, copy the example file and deploy — the package script loads it:

```sh
cp .env.example .env        # fill in the values; .env is gitignored
pnpm stack:plan
pnpm stack:deploy            # add `-- --yes` to skip the plan approval prompt
```

Without `.env`, authenticate an Alchemy profile once instead (`alchemy profile
edit --add Cloudflare`) and export only the VAPID values.

Alchemy stores state in a Cloudflare-hosted state store. Locally it reaches that
store through an Alchemy profile or through the environment credentials above.
In CI (`CI=true`) it uses the environment credentials and re-derives the store
token itself; `--yes` also lets CI upgrade an out-of-date store.

Stages isolate environments (`alchemy deploy --stage prod`), and every stage is
an instance of the same program.

### Deploy on push (GitHub Actions)

`.github/workflows/deploy.yml` runs `pnpm stack:deploy -- --yes` on every push
to `main` and on manual dispatch. The Cloudflare credential is minted by
Alchemy itself (`infra/github.stack.ts`), so no personal API token is pasted
into GitHub:

1. Create a one-shot `admin` profile. It needs **API Tokens > Write** to mint
   the CI token; do not use it for day-to-day deploys:

   ```sh
   cd infra
   pnpm exec alchemy profile create admin
   pnpm exec alchemy profile edit --profile admin --add Cloudflare
   ```

   Or configure it non-interactively from the repository `.env`:

   ```sh
   pnpm exec alchemy profile edit --profile admin --add Cloudflare \
     --method stored \
     --set apiToken=env:CLOUDFLARE_API_TOKEN \
     --set accountId=env:CLOUDFLARE_ACCOUNT_ID \
     --env-file ../.env
   ```

   The GitHub provider picks up the `gh` CLI login. If it cannot, export a
   token: `export GITHUB_TOKEN=$(gh auth token)`.

2. Run the CI stack once from the repository root:

   ```sh
   pnpm stack:ci    # alchemy deploy --config github.stack.ts --profile admin
   ```

   It creates a scoped account-owned token, pushes `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` to **Settings → Secrets and variables → Actions**,
   and records the token in the same remote state store as the app stack.
   Re-run it only to rotate the token or change its policies.

3. Add the Web Push identity as repository secrets (the app refuses to deploy
   without it):

   ```sh
   gh secret set VAPID_PRIVATE_KEY --body "$(grep VAPID_PRIVATE_KEY .env | cut -d= -f2-)"
   gh secret set VAPID_PUBLIC_KEY --body "$(grep VAPID_PUBLIC_KEY .env | cut -d= -f2-)"
   gh secret set VAPID_SUBJECT --body "$(grep VAPID_SUBJECT .env | cut -d= -f2-)"
   ```

4. Push to `main`. The deploy workflow pins `ALCHEMY_STAGE` to `demo`
   (the stage the current deployment uses); set a repository variable
   `ALCHEMY_STAGE` to target a different one. `TALI_BACKUPS` (default `on`) is
   also a repository variable. Until the Cloudflare token and the VAPID key are
   present, the workflow logs a warning and skips the deploy step instead of
   failing the push.

The push-triggered `CI` workflow still runs typecheck/build/test; the deploy
workflow is separate so a red test run never ships.

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

Capture (ADR-0012) uses `OPENCODE_API_KEY` (a Workers **secret**) plus optional
`CAPTURE_BASE_URL` / `CAPTURE_MODEL` vars. The base URL must be the OpenCode
**Go** root, `https://opencode.ai/inference/go/openai/v1`; the pay-as-you-go
root is a different path. A deploy without the key still succeeds and warns:
the feature is inert and every Dissect fails with a typed `ModelUnavailable`.
Set the key as a repository secret (`gh secret set OPENCODE_API_KEY --body …`)
for the deploy workflow.

## Observability

`TaliApi` ships with Workers Logs and Workers Traces enabled
(`observability.enabled`, `logs.invocationLogs`, `traces.enabled`). Traces are
head-sampled at **10%** by default (`TALI_TRACE_SAMPLE_RATE`, 0–1) and
`redactQueryString` removes request query strings from both signals. Traces
have seven-day retention in Workers Observability; persisted traces start
contributing to Cloudflare ingestion and storage billing on **2026-12-01**, so
the sampling rate is the cost lever.

What a sampled request shows in the Workers Observability waterfall:

- the fetch handler and an `http.span` named `POST /rpc` (or the matched route);
- `capture.dissect`, `capture.model.call`, and `capture.commit` with
  `capture.id`, `capture.proposal_count`, `capture.model.name`,
  `capture.model.duration_ms`, `capture.commit.created_count`,
  `capture.commit.remaining_count`, and `capture.outcome`;
- Cloudflare's automatic `fetch` span for the OpenCode Go model call, and one
  span per D1 statement, without extra code;
- the `http.client` span the browser's RPC client creates, when the api accepts
  inbound trace context.

User text, titles, bodies, quotes, questions, prompts, and draft payloads are
never span names or attributes. The api drops every attribute outside the
allowlisted namespaces and vetoes sensitive key tokens; the Foldkit app wraps
`OtlpTracer` in the same redactor because Foldkit attaches `command.args` to
Command spans. `TALI_TRACE_PROPAGATION=accept` merges the browser trace with the
api trace (it requires trace propagation on the Cloudflare account); otherwise
the two share only the `traceparent` ids Effect propagates.

### External OTLP

Dashboard-only is the default. To also export to Grafana, Honeycomb, Axiom, or
another OTLP/HTTP collector, set one or both URLs:

```sh
export TALI_OTLP_TRACES_URL=https://otel.example.com/v1/traces
export TALI_OTLP_TRACES_HEADERS='{"authorization":"Bearer <token>"}'
export TALI_OTLP_LOGS_URL=https://otel.example.com/v1/logs
export TALI_OTLP_LOGS_HEADERS='{"authorization":"Bearer <token>"}'
```

Each URL creates a `Cloudflare.Workers.ObservabilityDestination` and adds its
slug to the Worker's `traces.destinations` / `logs.destinations`. No endpoint or
token is committed. Cloudflare preflights the endpoint on create and update, so
it must answer a `POST` with 2xx; use `TALI_OTLP_*_SKIP_PREFLIGHT=1` on create
if the collector rejects empty probes. Removing the URL removes the
destination on the next deploy.

Browser export is separate and build-time, because the SPA is static:

```sh
export VITE_OTLP_TRACES_URL=https://otel.example.com/v1/traces
export VITE_OTLP_TRACES_HEADERS='{"authorization":"Bearer <browser-scoped-key>"}'
```

The value ends up in the bundle, so use a browser-scoped ingest key, never a
server token, and allow the collector's CORS preflight. Unset keeps Foldkit
Command spans in memory; the browser still propagates `traceparent`.

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
