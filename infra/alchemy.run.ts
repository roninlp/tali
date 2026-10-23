// Tali infrastructure as code — Alchemy v2 (the `alchemy` npm package).
//
// One stack, two ways to run it:
//
//   alchemy dev                    → everything local, no Cloudflare account
//   alchemy deploy --stage prod    → D1 + api Worker + web static assets
//
// `alchemy dev` runs the api Worker in workerd on :8787 against a local D1
// simulator (migrations applied on every reconcile), and spawns the web app's
// own Vite dev server on :3000. `alchemy deploy` provisions the real thing: D1
// with the same migrations, the api Worker, and the built SPA assets
// (`vite build` → dist/client) uploaded to the web Worker.
//
// Paths are resolved from this file, not the working directory, so the stack
// behaves the same whether it starts under Turbo (`infra/`) or from the repo
// root with `--config infra/alchemy.run.ts`.
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { CRON_EXPRESSIONS } from "@tali/config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { createECDH } from "node:crypto"
import { Buffer } from "node:buffer"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * `alchemy deploy` keeps state in the Cloudflare state store (a Worker in the
 * account). `alchemy dev` has no account to bootstrap it into, so the same
 * stack persists local state under `.alchemy/state` instead. The CLI sets
 * `ALCHEMY_DEV=true` on the process that evaluates this module.
 */
const isDev = process.env.ALCHEMY_DEV === "true" || process.env.ALCHEMY_DEV === "1"
const state = isDev ? Alchemy.localState() : Cloudflare.state()

/** The household database. Migrations under packages/sql are applied on deploy and on every dev reconcile. */
export const Database = Cloudflare.D1.Database("TaliDatabase", {
  migrations: join(repoRoot, "packages/sql/migrations")
})

/**
 * Nightly D1 backups (ticket #85).
 *
 * The api Worker dumps D1 into this bucket and keeps a 14-day window; the
 * bucket's lifecycle rule is a second, longer safety net (30 days) in case the
 * Worker is ever down long enough to miss its own cleanup. The dump is built by
 * the Worker rather than the provider export endpoint because D1 cannot export
 * a database containing FTS5 virtual tables (`notes_fts`). See
 * `docs/adr/0009-nightly-backup-and-trash-purge.md`.
 *
 * The bucket has no public access and no extra API token: the Worker reaches it
 * through an `r2_bucket` binding, the same way it reaches D1.
 */
export const Backups = Cloudflare.R2.Bucket("TaliBackups", {
  lifecycleRules: [
    {
      id: "expire-stale-backups",
      prefix: "backups/",
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 }
      }
    }
  ]
})

/**
 * VAPID identity (ticket #61; RFC 8292).
 *
 * The private key is a **Workers Secret** supplied out of band; the public key
 * and subject are ordinary config. No key pair is committed to this repository,
 * not even for development: a private key in git is a leaked key, and a
 * published "dev" pair that a deploy can fall back to is worse (it would sign
 * production pushes with a key the world has).
 *
 * Generate one locally (docs/web-push-local.md §1):
 *
 * ```sh
 * pnpm exec web-push generate-vapid-keys
 * export VAPID_PRIVATE_KEY=…      # keep it out of the repo
 * export VAPID_SUBJECT=mailto:you@example.com
 * pnpm dev
 * ```
 *
 * Only the private key needs to be supplied: the public half is derived with
 * Node's ECDH (this file runs at deploy time, not in the Worker). With no key in
 * a local run, dispatch is disabled (the ledger still records the inbox row);
 * a deploy without one fails instead of silently shipping an inbox-only app.
 */
const publicKeyOf = (privateKey: string): string => {
  const ecdh = createECDH("prime256v1")
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"))
  return ecdh.getPublicKey().toString("base64url")
}

const VAPID_DEV_SUBJECT = "mailto:dev@tali.local"

const vapid = (() => {
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? ""
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? ""
  const subject = process.env.VAPID_SUBJECT?.trim() ?? ""

  if (privateKey === "") {
    if (!isDev) {
      throw new Error(
        "VAPID_PRIVATE_KEY is required to deploy: generate one with " +
          "`pnpm exec web-push generate-vapid-keys` and export it (a Workers secret " +
          "in CI). See docs/web-push-local.md §1."
      )
    }
    console.warn(
      "[tali] VAPID_PRIVATE_KEY is not set: push dispatch is disabled and every " +
        "reminder is inbox-only. Generate a dev pair with " +
        "`pnpm exec web-push generate-vapid-keys` and export it before `pnpm dev`."
    )
    return { privateKey: "", publicKey: "", subject: "" }
  }

  if (subject === "" && !isDev) {
    throw new Error(
      "VAPID_SUBJECT is required to deploy (a mailto: or https: contact URI; " +
        "Apple rejects localhost subjects). See docs/web-push-local.md §1."
    )
  }

  return {
    privateKey,
    publicKey: publicKey === "" ? publicKeyOf(privateKey) : publicKey,
    // A local mailto is enough for a dev push service.
    subject: subject === "" ? VAPID_DEV_SUBJECT : subject
  }
})()

/**
 * The api Worker — a plain `async fetch` module (no Effect worker bridge), so
 * `env.DB` is the native `D1Database` the app already speaks through
 * `@effect/sql-d1`. The dev port is pinned because the web app's CORS
 * allow-list and `API_URL` default both point at :8787.
 *
 * `crons` is the reminder clock (ADR-0005 §1, #61): one per-minute trigger on
 * this Worker, handled by the module's `scheduled()` export. Alchemy attaches
 * the schedule at deploy time; `alchemy dev` runs no cron triggers, which is
 * why the app also exposes the dev-only `POST /dev/reminders/sweep` route
 * (`DEV_ROUTES=1` below, never set on a deploy).
 *
 * Ticket #85 adds two nightly triggers: purge at 03:17 UTC and backup at 03:47
 * UTC. They are separate invocations so each stays inside D1's per-invocation
 * query budget; the backup runs after the purge, so it captures the pruned
 * database. The expressions and the Worker's dispatch share
 * `@tali/config`'s `CRON_EXPRESSIONS`, so the two cannot drift.
 */
export const Api = Cloudflare.Worker("TaliApi", {
  main: join(repoRoot, "apps/api/src/index.ts"),
  compatibility: { date: "2026-10-09", flags: ["nodejs_compat"] },
  dev: { port: 8787, strictPort: true },
  crons: [...CRON_EXPRESSIONS],
  env: {
    DB: Database,
    // Nightly backup target and its window (ticket #85). The bucket is private;
    // the Worker writes through the binding, so no API token is involved.
    BACKUP_BUCKET: Backups,
    BACKUP_DATABASE_NAME: "tali",
    BACKUP_RETENTION_DAYS: "14",
    // Plain config (public by design); the private key binds as a secret.
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_SUBJECT: vapid.subject,
    VAPID_PRIVATE_KEY: Redacted.make(vapid.privateKey),
    DEV_ROUTES: isDev ? "1" : "0"
  }
})

export default Alchemy.Stack(
  "tali",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const database = yield* Database
    const backups = yield* Backups
    const api = yield* Api

    /**
     * The web SPA. Deploy runs the package's own `vite build` and uploads
     * `dist/client` as static assets with SPA fallback. In dev the build is
     * skipped and Vite serves the app itself on the port the app's config
     * pins (:3000), which is what the api Worker's `DEV_ORIGIN` expects.
     */
    const web = yield* Cloudflare.Website.StaticSite("TaliWeb", {
      cwd: join(repoRoot, "apps/web"),
      command: "pnpm run build",
      outdir: "dist/client",
      dev: { command: "pnpm exec vite", url: "http://localhost:3000" },
      assets: { notFoundHandling: "single-page-application" },
      env: { VITE_API_URL: api.url.as<string>() }
    })

    return {
      database: database.databaseName,
      backupBucket: backups.bucketName,
      apiUrl: api.url,
      webUrl: web.url
    }
  })
)
