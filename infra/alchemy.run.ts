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
import * as Effect from "effect/Effect"
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
 * The api Worker — a plain `async fetch` module (no Effect worker bridge), so
 * `env.DB` is the native `D1Database` the app already speaks through
 * `@effect/sql-d1`. The dev port is pinned because the web app's CORS
 * allow-list and `API_URL` default both point at :8787.
 */
export const Api = Cloudflare.Worker("TaliApi", {
  main: join(repoRoot, "apps/api/src/index.ts"),
  compatibility: { date: "2026-10-09", flags: ["nodejs_compat"] },
  dev: { port: 8787, strictPort: true },
  env: { DB: Database }
})

export default Alchemy.Stack(
  "tali",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const database = yield* Database
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
      apiUrl: api.url,
      webUrl: web.url
    }
  })
)
