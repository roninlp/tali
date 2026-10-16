# Research: Effect + Drizzle + D1 on Cloudflare Workers

**Ticket:** https://github.com/roninlp/tali/issues/2
**Question:** How do I wire Drizzle ORM and D1 (SQLite) into an Effect layered service architecture on Cloudflare Workers?
**Resolved:** 2026-10-16

---

## TL;DR (the decision)

Use **`@effect/sql-d1`** — Effect's own native D1 SQL client — as the primary path, **not** Drizzle.

- Effect v4 **removed** the `@effect/sql-drizzle` package; the Drizzle integration now lives inside `drizzle-orm` itself (`drizzle-orm/effect-d1`), but it is **incomplete for D1** (no atomic `batch()`, and its `.transaction()` dies at runtime because `@effect/sql-d1` cannot do transactions).
- `@effect/sql-d1` is Effect-first, plugs straight into the `SqlClient` service + `Layer` model, and gives you typed rows mapped to `@effect/schema` types via `SqlSchema` / `SqlModel` / `SqlResolver` / `Schema.Model`.
- **Migrations** are the one place to keep Drizzle (or plain wrangler): Effect's `Migrator` runs migrations inside `withTransaction`, which dies on D1, so it cannot be used. Run migrations out-of-band with `drizzle-kit` (d1-http driver) or `wrangler d1 migrations apply`.
- **Transactions**: D1 has no interactive transactions, so `SqlClient.withTransaction` / `SqlModel` `makeResolvers` cross-row atomicity are off the table. Use `D1Client.batch()` (D1's native atomic multi-statement) for atomicity.

If a higher-level query builder is genuinely wanted on top of the D1 client, Drizzle's `drizzle-orm/d1` (plain, promise-based) can be wrapped manually — but the Effect-native SQL client already covers the layered-service + schema-mapping need.

---

## 1. Current state of Effect's Drizzle integration

### 1.1 `@effect/sql-drizzle` was removed in Effect v4

The standalone `@effect/sql-drizzle` package (with `Mysql`, `Pg`, `Sqlite` modules) no longer exists in Effect v4. The official migration guide redirects each of its APIs to Drizzle's own Effect modules:

> `@effect/sql-drizzle/Sqlite` → "The package was removed; select the matching drizzle-orm Effect backend module … use the module matching sql-sqlite-node, -bun, -do, -wasm, libsql, or d1."

- Source: `repos/effect/migration/v3-to-v4.md` (lines 601–603, 7935–7969) and `repos/effect/migration/annotations/effect__sql-drizzle__*.yaml`.

The same migration guide also removed `@effect/sql-kysely` and merged `@effect/sql` into the `effect` package (`effect/sql`).

- Source: `repos/effect/migration/v3-to-v4.md` (lines 598, 604).

### 1.2 Drizzle's own Effect integration now exists, but D1 support is thin

Drizzle ships Effect-native entrypoints inside `drizzle-orm` itself:

- `drizzle-orm/effect-postgres` — `PgDrizzle.makeWithDefaults()`, returns `EffectPgDatabase` (Effect service pattern). Source: https://orm.drizzle.team/docs/connect-effect-postgres
- `drizzle-orm/effect-mysql2`
- `drizzle-orm/effect-d1` — the D1/SQLite Effect driver, `EffectSQLiteD1Database`. Shipped in `drizzle-orm@1.0.0-rc.4` (2026-06-29), backed by `@effect/sql-d1`.
- `drizzle-orm/effect-schema` — generates `@effect/schema` schemas (`createSelectSchema`, `createInsertSchema`, …) from Drizzle table definitions. Source: https://orm.drizzle.team/docs/sqlite/effect-schema

**But the D1 Effect driver does not cover D1's full seam.** This is documented in detail in a tracked upstream-dependency issue:

> - No atomic `batch()` in the native driver: `drizzle-orm/effect-d1`'s `EffectSQLiteD1Database` exposes only `.transaction()`, and `@effect/sql-d1`'s `transactionAcquirer = Effect.die("transactions are not supported in D1")` … swapping to the native driver would `Effect.die` at runtime on D1.
> - Version floor: `drizzle-orm/effect-d1`'s peer requires `@effect/sql-d1` / `effect ≥ 4.0.0-beta.83`.

- Source: https://github.com/kamp-us/phoenix/issues/727 (comments 6, 10 — the "rc.4 did NOT fully unblock this" analysis). Also notes the driver surface lives at `drizzle-orm/effect-d1/{driver,session}.d.ts`, `drizzle-orm/sqlite-core/effect/db.d.ts`, and `@effect/sql-d1/src/D1Client.ts`.

**Takeaway:** the "Effect + Drizzle on D1" path is real but immature — Drizzle's Effect D1 driver is a thin adaptor over `@effect/sql-d1` that currently lacks D1's atomic batch and dies on transactions. Using `@effect/sql-d1` directly is strictly more capable today.

---

## 2. The Effect-native D1 client: `@effect/sql-d1`

This is the authoritative, first-class integration. It is vendored in this repo.

- Package: `@effect/sql-d1` (vendored version **4.0.5**). Source: `repos/effect/packages/sql/d1/package.json`.
- Docs pointer (from its README): https://effect.website/docs/v4/api/sql-d1
- It adapts a Workers `D1Database` binding into both the D1-specific `D1Client` service **and** the generic `SqlClient` service.

### 2.1 What it supports / does not support

From the module docstring and implementation (`repos/effect/packages/sql/d1/src/D1Client.ts`):

| Capability | D1 status | Notes |
|---|---|---|
| Tagged-template queries (`sql\`\``) | ✅ | via `SqlClient` / `Statement` |
| `D1Client.batch()` — atomic multi-statement | ✅ | wraps `db.batch()`; rolls back together |
| Prepared-statement cache | ✅ | capacity 200, TTL 10 min (configurable) |
| `transformQueryNames` / `transformResultNames` | ✅ | snake_case ↔ camelCase |
| Tracing spans / `spanAttributes` | ✅ | `db.system.name = "sqlite"` |
| **`withTransaction`** | ❌ | `transactionAcquirer = Effect.die("transactions are not supported in D1")` |
| **Streaming queries** (`stream`) | ❌ | `executeStream` → `Stream.die("executeStream not implemented")` |
| **`updateValues`** | ❌ | typed `never` |

Key source lines: `D1Client.ts`:
- `make()` / `layer()` / `layerConfig()` (lines 215–429)
- `transactionAcquirer = Effect.die(...)` (line 340)
- `executeStream` → `Stream.die(...)` (lines 331–333)
- `updateValues: never` (line 93)
- prepared-statement cache defaults `200` / `Duration.minutes(10)` (lines 232–233)

### 2.2 Configuration

```ts
// repos/effect/packages/sql/d1/src/D1Client.ts (lines 117–125)
interface D1ClientConfig {
  readonly db: D1Database                    // the Workers binding
  readonly prepareCacheSize?: number         // default 200
  readonly prepareCacheTTL?: Duration.Input  // default 10 minutes
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string  // snake_case -> camelCase
  readonly transformQueryNames?: (str: string) => string   // camelCase -> snake_case
}
```

`D1Client.layer(config)` and `D1Client.layerConfig(Config.Wrap<config>)` provide **both** `D1Client` and `SqlClient` into the context (lines 400–429).

---

## 3. Wiring the Layer on Cloudflare Workers

The Worker gets a `D1Database` binding from `env` (wrangler config). Build the layer per-request (D1 has no connection pool; the binding is cheap to pass into a layer).

```ts
import { D1Client } from "@effect/sql-d1"
import { Effect, Layer } from "effect"

interface Env {
  DB: D1Database
}

export default {
  async fetch(request: Request, env: Env) {
    const program = Effect.gen(function*() {
      const sql = yield* D1Client.D1Client        // or yield* SqlClient
      return yield* sql`SELECT 1 as ok`
    })

    // One layer per request, backed by the binding:
    const layer = D1Client.layer({ db: env.DB })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    return Response.json(result)
  }
}
```

- `D1Client.D1Client` is the service tag (`Context.Service`), also aliased to `SqlClient`. Source: `repos/effect/packages/sql/d1/src/D1Client.ts` (line 108) and `SqlClient.ts` (line 155).
- If the binding name is dynamic or read from config, use `D1Client.layerConfig` instead of `layer` (line 400).

For **tests / local dev**, Miniflare is the canonical way to get a `D1Database` (the vendored test does exactly this):

```ts
// repos/effect/packages/sql/d1/test/utils.ts
const miniflare = new Miniflare({ workers: [{ config: { /* env: { DB: { type: "d1", id: ... } } */ } }] })
const db = await miniflare.getD1Database("DB")
const layer = D1Client.layer({ db })
```

---

## 4. Typed rows → `@effect/schema` types

There are two orthogonal mapping tools, both in the `effect` package:

### 4.1 `Schema.Model` — one source of truth, derived variants

`Schema.Model` keeps one field declaration and derives `select` / `insert` / `update` / `json` variants. This is the Effect-idiomatic way to model a table row.

```ts
import { Schema } from "effect"
import { Model } from "effect/schema"

export const UserId = Schema.Number.pipe(Schema.brand("UserId"))

export class User extends Model.Class<User>("User")({
  id: Model.GeneratedByDb(UserId),          // omitted on insert, present on select
  name: Schema.String,
  createdAt: Model.DateTimeInsertFromDate,  // set on insert, never on update
  updatedAt: Model.DateTimeUpdateFromDate   // set on insert + update
}) {}

User         // select schema (decode rows)
User.insert  // insert schema (encode inputs)
User.update  // update schema
User.json    // public API schema
```

Source: `repos/effect/packages/effect/src/schema/Model.ts` (docstring + `Model.Class` example, lines 79–120).

### 4.2 `SqlSchema` — encode request / decode rows around a query

`SqlSchema` builds a typed function from `Request` + `Result` schemas and an `execute` callback that returns raw `unknown` rows:

- `SqlSchema.findAll` / `findNonEmpty` / `findOne` / `findOneOption` / `void`
- It runs `Schema.encodeEffect(Request)` before the query and `Schema.decodeUnknownEffect(Result)` on the returned rows.

Source: `repos/effect/packages/effect/src/sql/SqlSchema.ts`.

```ts
import { SqlSchema, SqlClient } from "effect/sql"
import { Effect } from "effect"

const findByName = SqlSchema.findAll({
  Request: Schema.String,
  Result: User,
  execute: (name) => sql`SELECT * FROM users WHERE name = ${name}`
})
// findByName: (name: string) => Effect.Effect<User[], SqlError | SchemaError, ...>
```

### 4.3 The tagged-template `sql` API (typed rows)

`SqlClient` is also a tagged-template `Constructor`. You can annotate the row type inline; the returned `Statement<A>` is already an `Effect` of `ReadonlyArray<A>`:

```ts
const rows = yield* sql<{ id: number; name: string }>`SELECT id, name FROM users`
// rows: Array<{ id: number; name: string }>
```

Full `Constructor` surface (from `repos/effect/packages/effect/src/sql/Statement.ts`, lines 478–570): `sql\`\``, `sql.unsafe`, `sql.in`, `sql.insert`, `sql.update`, `sql.updateValues`, `sql.and`, `sql.or`, `sql.csv`, `sql.join`, `sql.onDialect`, `sql.onDialectOrElse`, plus per-statement `.raw`, `.withoutTransform`, `.values`, `.unprepared`, `.compile()`.

`onDialectOrElse` lets a repository branch on dialect; for D1 the fallthrough (`orElse`) is SQLite. Source: `Statement.ts` line 645.

---

## 5. Repository patterns

### 5.1 Derived CRUD repository: `SqlModel.makeRepository`

`SqlModel.makeRepository(Model, { tableName, spanPrefix, idColumn, softDeleteColumn? })` returns a typed CRUD repo (`insert`, `insertVoid`, `update`, `updateVoid`, `findById`, `delete`) from a `Schema.Model`. It uses `SqlSchema` under the hood, and `onDialectOrElse` with a SQLite/`RETURNING` path as the `orElse` branch.

Source: `repos/effect/packages/effect/src/sql/SqlModel.ts` (lines 35–223).

```ts
import { SqlModel } from "effect/sql"

export class UsersRepo extends Effect.Service<UsersRepo>()("UsersRepo", {
  effect: Effect.gen(function*() {
    const repo = yield* SqlModel.makeRepository(User, {
      tableName: "users",
      spanPrefix: "Users",
      idColumn: "id"
    })
    return {
      create: repo.insert,        // User["insert"]["Type"] -> User["Type"]
      getById: repo.findById,     // id -> User (NoSuchElementError if missing)
      remove: repo.delete,
      update: repo.update
    }
  }),
  dependencies: [SqlClient.SqlClient]   // or [D1Client.D1Client]
}) {}
```

**Caveat:** `makeResolvers` (the batched `RequestResolver` variant) is safe, but the CRUD repo's individual `insert`/`update` are single statements; for atomic multi-row work you must wrap them in `D1Client.batch()` yourself — D1 has no transactions.

### 5.2 Manual `SqlSchema`-based repository (most explicit)

Wrap any query with `SqlSchema` for full control. This is the pattern to use when the derived CRUD isn't enough (joins, aggregates, partial updates):

```ts
const create = SqlSchema.findOne({
  Request: User.insert,
  Result: User,
  execute: (u) => sql`INSERT INTO users ${sql.insert(u)} RETURNING *`
})
```

### 5.3 Batched data loading: `SqlResolver` + `RequestResolver`

`SqlResolver.ordered` / `findById` / `void` turn queries into `RequestResolver`s that **batch and deduplicate concurrent requests** (with `Effect.request`). Handy for N+1 avoidance. Source: `repos/effect/packages/effect/src/sql/SqlResolver.ts`.

```ts
const byId = yield* SqlResolver.findById({
  Id: User.fields.id,
  Result: User,
  ResultId: (u) => u.id,
  execute: (ids) => sql`SELECT * FROM users WHERE ${sql.in("id", ids)}`
})
// usage: Effect.request(SqlResolver.SqlRequest(id), byId)
```

`SqlModel.makeResolvers` wraps all four CRUD ops as resolvers in one call (source: `SqlModel.ts` lines 233–362).

---

## 6. Migrations

### 6.1 Effect's `Migrator` does **not** work on D1

The Effect SQL migrator runs pending migrations inside `sql.withTransaction(run)` (non-clickhouse dialects), and D1's `withTransaction` dies. So `Migrator.make(...)` is unusable against D1 as-is.

- Source: `repos/effect/packages/effect/src/sql/Migrator.ts` (line 334, `orElse: () => sql.withTransaction(run)`), combined with `@effect/sql-d1`'s `transactionAcquirer = Effect.die(...)`.
- The migrator's table is `effect_sql_migrations` and its loaders are `fromGlob` / `fromBabelGlob` / `fromRecord` / `fromFileSystem` (Migrator.ts lines 373–492) — all only useful on a transactional driver.

### 6.2 Use `drizzle-kit` (recommended) or wrangler

Drizzle's kit targets D1 directly via the `d1-http` driver, and generates versioned migration folders:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!
  }
})
```

- Source: https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1 and https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit

Commands:

```sh
npx drizzle-kit generate          # write migration SQL from schema diffs
npx drizzle-kit migrate           # apply to remote D1 (d1-http)
# or, Cloudflare-native:
npx wrangler d1 migrations apply <DB_NAME> --remote
```

Note that Drizzle schemas are the Drizzle side (`sqliteTable(...)`); if you go the `@effect/sql-d1` route for runtime data access, you can either (a) keep a Drizzle schema solely as the migration source of truth, or (b) hand-write SQL migrations and apply them with `wrangler d1 execute --file`. There is no Effect-native migrator for D1 today.

---

## 7. Transactions and atomicity on D1

- D1 has **no interactive `BEGIN`/`COMMIT`/`ROLLBACK`** — each statement is its own transaction, and the only atomic multi-statement primitive is the native **batch** (`db.batch()`), which the `D1Client.batch()` method wraps (source: `D1Client.ts` lines 142–206).
- `SqlClient.withTransaction` and Drizzle's `.transaction()` both **die** on D1 (source: `D1Client.ts` line 340; phoenix issue #727).
- `batch()` is atomic and rolls back all statements on failure — verified by the vendored test "should roll back a failed batch" (source: `repos/effect/packages/sql/d1/test/Client.test.ts` lines 154–168).

```ts
const [a, b] = yield* sql.batch([
  sql`INSERT INTO accounts ${sql.insert({ name: "a" })}`,
  sql`INSERT INTO accounts ${sql.insert({ name: "b" })}`
] as const)
// all-or-nothing, in one D1 request
```

Batch also **cannot** be nested inside a transaction (`withTransaction` + `batch` defects) — source: `Client.test.ts` lines 232–246.

---

## 8. Recommendation summary

| Need | Use |
|---|---|
| Runtime data access on D1 | `@effect/sql-d1` (`D1Client` + `SqlClient` layer) |
| Typed rows → schema | `Schema.Model` + `SqlSchema` (`findOne`/`findAll`) |
| Repository / CRUD | `SqlModel.makeRepository`, or hand-written `SqlSchema` |
| Batched/deduped reads (N+1) | `SqlModel.makeResolvers` / `SqlResolver` |
| Atomicity (no transactions) | `D1Client.batch()` |
| Migrations | `drizzle-kit` (d1-http) or `wrangler d1 migrations apply` |
| Drizzle as query builder | Optional: `drizzle-orm/d1` (promise API, wrapped manually); the Effect D1 driver (`drizzle-orm/effect-d1`) is not yet sufficient |

**Packages / versions (as of writing):**
- `effect` **4.0.5** (vendored) — `effect/sql` (`SqlClient`, `Statement`, `SqlSchema`, `SqlModel`, `SqlResolver`, `Migrator`), `effect/schema` (`Model`).
- `@effect/sql-d1` **4.0.5** (vendored).
- `drizzle-orm` `1.0.0-rc.4+` for `effect-d1` (requires `effect ≥ 4.0.0-beta.83`); `drizzle-orm/d1` for the plain D1 driver; `drizzle-kit` `0.21.3+` for migrations.
