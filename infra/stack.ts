// Tali infrastructure as code — Alchemy v2 (the `alchemy` npm package).
//
// Deploy per environment (stages are isolated instances of the same Stack):
//   alchemy plan --stage dev
//   alchemy deploy --stage dev
//   alchemy deploy --stage prod --yes
//
// See docs/research/alchemy-v2-cloudflare.md for the API surface this follows.
// NOTE: this file is illustrative and is NOT type-checked in the monorepo build
// (Alchemy has its own CLI); verify with `alchemy plan` once Cloudflare creds
// are configured.
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import * as Effect from "effect/Effect"

// D1 database. Migrations under packages/sql/migrations are applied on deploy.
const Database = Cloudflare.D1.Database("tali-db", {
  migrations: "../../packages/sql/migrations"
})

// The api Worker, bound to the D1 database via a typed binding.
const Api = Cloudflare.Worker(
  "tali-api",
  { main: "../../apps/api/src/index.ts" },
  Effect.gen(function*() {
    yield* Cloudflare.D1.QueryDatabase(Database)
    return {
      fetch: (_request: Request) =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        })
    }
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
)

export default Stack(
  "tali",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const db = yield* Database
    const api = yield* Api
    return {
      database: db.databaseName,
      apiUrl: api.url
    }
  })
)
