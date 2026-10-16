# Research: Alchemy v2 on Cloudflare (D1, Cron, Queues, secrets)

**Ticket:** https://github.com/roninlp/tali/issues/3
**Question:** What does Alchemy v2 provision on Cloudflare for this app, and how is each declared as typed TypeScript?

---

## TL;DR — what "Alchemy v2" actually is

"Alchemy v2" is **not ambiguous in spirit but slightly imprecise in name**. The real package is:

- **npm package:** [`alchemy`](https://www.npmjs.com/package/alchemy) — current version **`2.0.0-beta.83`** (the "v2" is the *major version*, still in **beta**).
- **Description:** *"Infrastructure as Effects for TypeScript."* IaC + application runtime in one typed Effect program. Same family as Terraform / Pulumi / CDK.
- **Homepage / docs:** https://alchemy.run (v1 docs live at https://v1.alchemy.run).
- **Source:** https://github.com/alchemy-run/alchemy (formerly `sam-goodwin/alchemy`; author Sam Goodwin).
- **Why "v2":** Alchemy **v1** was an `async/await` IaC library (`await alchemy("app")`, `alchemy/cloudflare`). **v2** rewrote it on **Effect** (`Alchemy.Stack`, `alchemy/Cloudflare`, `yield*`, Layers). There is a dedicated migration guide: https://alchemy.run/migrating-from-v1.

**Naming flag for the stack card.** The user-facing package is `alchemy` (not `@alchemy/*`). The `@alchemy/*` convention from `AGENTS.md`/the ticket prompt is a near-miss: the `@alchemy.*` names are *internal* packages (`@alchemy.run/cloudflare-runtime`, `@alchemy.run/floci`, `@alchemy.run/node-utils`, `@alchemy.run/frontend-frameworks`) and the underlying Cloudflare provider is `@distilled.cloud/cloudflare`. Application code imports from `alchemy` and its subpaths (`alchemy/Cloudflare`, `alchemy/Stack`, `alchemy/SQL/D1`, …). No `@alchemy/…` import is used in app code.

**Stability flag.** `alchemy` is at `2.0.0-beta.83` and vendors `wrangler ^4.103.0` as its Cloudflare engine. The Cloudflare provider is broad (Workers, Durable Objects, Workflows, D1, R2, KV, Queues, Cron, Secrets Store, Hyperdrive, Vectorize, Access, Turnstile, …) but the whole framework is pre-1.0. Treat it as preview-grade for production planning.

**Stale-docs warning.** Some secondary mirrors (e.g. a `mintlify.com` snapshot) still show the **v1** `await` API (`import { D1Database } from "alchemy/cloudflare"`). The current API is the Effect-based one below — trust `alchemy.run` (and `llms.txt`) as source of truth.

---

## What the Cloudflare provider provisions

`Cloudflare.providers()` bundles every built-in Cloudflare resource/provider as an Effect `Layer`. From the source `packages/alchemy/src/Cloudflare/Providers.ts` the collection includes (relevant subset): `D1.Database`, `Queue.Queue` / `Queue.Consumer` / `Queue.Subscription`, `R2.Bucket`, `KV.Namespace`, `Workers.Worker`, `Workflows.WorkflowResource`, `SecretsStore.Secret` / `SecretsStore.Store`, `Hyperdrive.Connection`, `Vectorize.Index`, `Access.*`, `Turnstile.Widget`, `DurableObject` namespaces, plus hundreds of Cloudflare API resources.

The engine (`alchemy deploy`) plans the resource graph, diffs against persisted state, and reconciles each resource via its provider. Resources are declared as **Effects**, bound to Workers via **bindings** (one line = IAM/env-var/typed-client), and the type system rejects a Cloudflare resource without `Cloudflare.providers()` at compile time.

---

## 1. D1 database + bindings

D1 is serverless SQLite — a single resource declaration, no provisioning/scale config.

**Declare the database** (`src/database.ts`):

```ts
import * as Cloudflare from "alchemy/Cloudflare";

export const Database = Cloudflare.D1.Database("Database");
```

**With migrations** (`.sql` files sorted by numeric prefix, applied on every deploy, idempotent):

```ts
const db = yield* Cloudflare.D1.Database("my-db", {
  migrations: "./migrations",
});
```

**Bind into a Worker and query** (`src/worker.ts`) — `QueryDatabase` + `QueryDatabaseBinding` layer:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Database } from "./database.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Construction phase: register the binding, get a typed client
    const db = yield* Cloudflare.D1.QueryDatabase(Database);

    return {
      fetch: Effect.gen(function* () {
        const results = yield* db
          .prepare("SELECT * FROM reminders WHERE due_at <= ? AND delivered = 0")
          .bind(Date.now())
          .all();
        return yield* HttpServerResponse.json(results);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);
```

**Effect SQL / tagged templates** (recommended for this app — matches the Effect backend): `alchemy/SQL/D1` wraps the binding in `@effect/sql-d1`, parameterizes interpolations, and surfaces typed `SqlError`s. It also implements `effect/sql/SqlClient`, so domain services written against `SqlClient` run unchanged:

```ts
import * as SQL from "alchemy/SQL/D1";
import * as SqlClient from "effect/sql/SqlClient";

Effect.gen(function* () {
  const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
  const sql = yield* SQL.D1(d1);

  return {
    fetch: Effect.gen(function* () {
      const due = yield* sql`SELECT * FROM reminders WHERE delivered = 0`;
      return yield* HttpServerResponse.json({ due });
    }),
  };
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding));

// Or provide SqlClient generically:
const app = yield* makeApp.pipe(Effect.provide(SQL.D1Layer(d1)));
```

Runnable example: `examples/cloudflare-effect-sql-d1` in the repo. Stack output exposes `db.databaseName`.

---

## 2. Cron Triggers — per-minute reminder scan

`Cloudflare.Workers.cron(expression, handler)` does both halves: it attaches the cron expression to the Worker at deploy time **and** registers the `scheduled` listener that runs the Effect on each fire. Provide `Cloudflare.Workers.CronEventSourceLive`.

**Per-minute scan** (`* * * * *` — Cloudflare's fastest granularity is 1 minute):

```ts
// src/worker.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* Cloudflare.Workers.cron("* * * * *", (controller) =>
      ReminderService.scanDue(), // Effect: query D1, enqueue undelivered
    );

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
);
```

`controller` is Cloudflare's `ScheduledController` (`controller.scheduledTime`, `controller.cron`). Register `cron` once per schedule; each handler runs only for its own expression. A failing handler is caught by the event source (doesn't crash the Worker) — log/report inside the handler for visibility.

**Alternative for plain async Workers:** `Cloudflare.Worker("W", { main, crons: ["* * * * *"] })`.

**Stack wiring / output:**

```ts
export default Alchemy.Stack(
  "CronApp",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url.as<string>(), crons: worker.crons };
  }),
);
```

> If the scan should be durable multi-step work instead of fire-and-forget, use a **Workflow** with `schedules` (see §7 note), but for a simple scan-due-and-dispatch a cron-triggered Worker is the direct match.

---

## 3. Queues — optional, but fits push dispatch

Cloudflare Queues give **at-least-once** delivery between Workers with automatic ack/retry and dead-lettering. For this app, a Queue is the right tool for **"quiet hours queue, never drop"** and Web Push dispatch with retry/backoff (decouple the API response from push delivery). It's *optional* — a cron-triggered Worker can dispatch push directly — but the feature map's retry/backoff + never-drop requirements map cleanly onto it.

**Declare the queue:**

```ts
import * as Cloudflare from "alchemy/Cloudflare";
export const PushQueue = Cloudflare.Queues.Queue("PushQueue");
```

**Producer side** — `Cloudflare.Queues.WriteQueue(queueResource)` + `WriteQueueBinding`:

```ts
Effect.gen(function* () {
  const queueResource = yield* PushQueue;
  const queue = yield* Cloudflare.Queues.WriteQueue(queueResource);

  return {
    fetch: Effect.gen(function* () {
      yield* queue.send({ subscriptionId, payload }).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ queued: true }, { status: 202 });
    }),
  };
}).pipe(Effect.provide(Cloudflare.Queues.WriteQueueBinding));
```

**Consumer side** — `Cloudflare.Queues.consumeQueueMessages(queue, props, handler)` + `EventSourceLive`; it registers the listener **and** auto-creates the `Cloudflare.Queues.Consumer` resource:

```ts
yield* Cloudflare.Queues.consumeQueueMessages<PushMessage>(
  PushQueue,
  {
    batchSize: 25,
    maxRetries: 3,           // retry/backoff for push dispatch
    maxWaitTime: "5 seconds",
    retryDelay: Duration.seconds(30),
  },
  (stream) => Stream.runForEach(stream, (msg) => PushService.deliver(msg.body)),
);
// + Effect.provide(Cloudflare.Queues.EventSourceLive)
```

Acking is automatic (success ⇒ `ack()`, failure ⇒ `retry()` up to `maxRetries`, then dead-letter). For finer control call `msg.ack()` / `msg.retry()` per message. `Cloudflare.Queues.QueueSink(queue)` exposes the queue as an Effect `Sink` for draining streams.

---

## 4. Secrets / VAPID keys

VAPID = `{ subject (mailto:), publicKey, privateKey }`. The public key + subject are **not** secrets (they're embedded in the client's `pushManager.subscribe`). Only the **private key** is a secret.

Three supported mechanisms, chosen by where the value lives:

### (a) Per-Worker secret from your env — `Config.Redacted` (recommended for VAPID private key)

`Config` yielded in the Worker's **Construction** phase is read from your environment at deploy time and bound as `secret_text`:

```ts
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const vapidPrivate = yield* Config.Redacted("VAPID_PRIVATE_KEY"); // binds as secret_text

    return {
      fetch: Effect.gen(function* () {
        // unwrap only at the call site
        const key = Redacted.value(vapidPrivate);
        return yield* PushService.send({ privateKey: key, /* ... */ });
      }),
    };
  }),
);
```

Load the value with `--env-file` / CI secrets. **Gotcha:** resolve `Config` in the constructor (outer `Effect.gen`), never inside `fetch` — `fetch` doesn't run at deploy time, so a `Config` only discovered there is never bound.

### (b) Infrastructure-minted stable token — `Alchemy.Random`

For secrets your infra owns (webhook secret, bearer token) that must stay stable across deploys:

```ts
import { Random } from "alchemy";
export const VapidPrivateValue = Random("VapidPrivateKey"); // 32 bytes hex, persisted in state
```

`.text` is `Redacted<string>` (never leaks to logs).

### (c) Shared / rotating secret — Cloudflare Secrets Store

Account-level store, one `Store` per account (adopted, never deleted on destroy), read **live at runtime** so rotation propagates without redeploying consumers:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const Store = Cloudflare.SecretsStore.Store("AuthSecrets");

export const VapidPrivate = Effect.gen(function* () {
  const store = yield* Store;
  const value = yield* VapidPrivateValue; // or Redacted.make(process.env.VAPID_PRIVATE_KEY!)
  return yield* Cloudflare.SecretsStore.Secret("VapidPrivateKey", { store, value: value.text });
});

// In the Worker:
const vapid = yield* Cloudflare.SecretsStore.ReadSecret(VapidPrivate); // Redacted<string>, read live
// + Effect.provide(Cloudflare.SecretsStore.ReadSecretBinding)
```

**Decision rule (from the docs):** env-var (`Config.Redacted`) ⇒ value from *your* env baked into one Worker — right for third-party keys / per-app config. Secrets Store ⇒ value lives in *Cloudflare's* account store, shared across Workers, rotates without redeploy — right for shared/rotated credentials. For a VAPID private key used only by the push Worker, **(a) `Config.Redacted("VAPID_PRIVATE_KEY")`** is the simple, correct default; graduate to **(c)** if the key must rotate across multiple Workers or the value is minted as infra.

---

## 5. Per-environment stacks (dev / staging / prod)

Environments are **stages** — isolated instances of the same Stack, each with its own state file and physical names (`myapp-prod-…` vs `myapp-dev_sam-…`). Deploying/destroying one stage never touches another.

```sh
alchemy deploy --stage dev
alchemy deploy --stage staging
alchemy deploy --stage prod
```

Defaults: `alchemy deploy` ⇒ `live_$USER`; `alchemy dev` ⇒ `dev_$USER`; `Test.make` ⇒ `test_$USER`. Resolution order: `--stage` flag → `$ALCHEMY_STAGE` env → per-user default.

**Branch the same program per stage** via the `Stack` service (inside `Effect.gen`):

```ts
import { Stack } from "alchemy/Stack";

Effect.gen(function* () {
  const stack = yield* Stack; // stack.stage === "prod" | "staging" | "dev" | …
  const queue = yield* Cloudflare.Queues.Queue("PushQueue").pipe(
    RemovalPolicy.retain(stack.stage === "prod"),
  );
});
```

Or at module scope with `Stack.useSync`:

```ts
export const Database = Cloudflare.D1.Database(
  "Database",
  Stack.useSync((stack) => ({
    migrations: "./migrations",
    name: stack.stage === "prod" ? "tali-prod" : undefined,
  })),
);
```

**Stages vs profiles are orthogonal:** stages isolate *what* is deployed; **profiles** (`--profile`) isolate *how* alchemy authenticates (`~/.alchemy/profiles.json`). Pair them: `alchemy deploy --stage prod --profile prod`. Credentials are stored in profiles (OAuth or API token) — **no** `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` env vars needed for local deploys.

CI pattern for per-environment + PR previews:

```yaml
- run: alchemy deploy --stage prod --yes
- run: alchemy deploy --stage pr-${{ github.event.number }} --yes   # preview
- run: alchemy destroy --stage pr-${{ github.event.number }} --yes # on merge
```

---

## 6. Deploy / diff / rollback flow

**Diff (plan).** `alchemy plan` (≡ `alchemy deploy --dry-run`) diffs declared state vs persisted state and prints `+` create, `~` update, `±` replace, `-` delete, `•` no-op. `--detailed` adds a YAML property view; secrets stay redacted; `(known after apply)` marks unresolved outputs.

**Deploy.** `alchemy deploy` plans, prompts for approval (`--yes` skips), then applies in dependency order — only changed resources are updated; a no-change plan skips the prompt. Flags: `--stage`, `--yes`, `--dry-run`, `--force`, `--adopt`, `--profile`, `--env-file`, `--config`.

**Rollback.** There is **no dedicated `rollback` command**. Rollback is **"a deploy"** exactly as the stack card says: infrastructure is declarative, so reverting is `git revert` the bad change and `alchemy deploy --stage prod` again — the plan reverts the diff. Supporting commands:

- `alchemy drift [--stage prod] [--repair] [--yes]` — re-observe the cloud and report (or repair) out-of-band changes back to last-deployed state.
- `alchemy destroy --stage <stage>` — tear down a whole stage in reverse dependency order.
- `alchemy state` / `alchemy logs` / `alchemy cloudflare` — inspect persisted state, tail logs, bootstrap the state-store Worker.
- **Worker gradual deployments** (`alchemy.run/cloudflare/compute/gradual-deployments`) — canary a % of live traffic and ramp, if you want in-place rollback *without* a full redeploy for the Worker alone.

State store: `Cloudflare.state()` persists resource state in a Cloudflare-hosted Worker backed by a Durable Object (bootstrapped on first deploy; the Secrets Store entries holding its auth/encryption keys are shared account-wide). Alternative: `State.State()` keeps state on disk under `.alchemy/`.

---

## Sources

Primary only:

- `alchemy` npm registry metadata (`2.0.0-beta.83`, author, repo, subpath exports, `wrangler ^4.103.0`): https://registry.npmjs.org/alchemy/latest
- Docs index (`llms.txt`): https://alchemy.run/llms.txt
- D1: https://alchemy.run/cloudflare/data/d1
- Cron Triggers: https://alchemy.run/cloudflare/messaging/cron
- Queues: https://alchemy.run/cloudflare/messaging/queues
- Secrets Store: https://alchemy.run/cloudflare/security/secrets-store
- Secrets & env: https://alchemy.run/cloudflare/security/secrets-env
- Stages: https://alchemy.run/environments/stages
- Migrating from v1 (v1 vs v2 semantics): https://alchemy.run/migrating-from-v1
- Stacks / Providers / Resource lifecycle: https://alchemy.run/infrastructure-as-code/stack , …/provider , …/resource-lifecycle
- CLI `deploy` / `plan` / `drift`: https://alchemy.run/cli/deploy , …/cli/plan , …/cli/drift
- Provider source (resource collection): https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/src/Cloudflare/Providers.ts
- Cloudflare docs wrapped: D1, Cron Triggers, Queues, Secrets Store (linked from the above pages)
