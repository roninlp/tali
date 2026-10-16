# Tali — Error Model & Typed Error Hierarchy (Draft)

> **Status:** PROTOTYPE — concrete draft for the owner + developer to react to. Not a final contract.
> **Ticket:** [#10](https://github.com/roninlp/tali/issues/10) (HITL prototype)
> **Builds on:** [#7](https://github.com/roninlp/tali/issues/7) `docs/domain-model-draft.md` (settled domain model), [#8](https://github.com/roninlp/tali/issues/8) `docs/sync-protocol-draft.md` (settled sync protocol), and the settled transport decisions on the [map #1](https://github.com/roninlp/tali/issues/1).
> **Source authority:** the scaffold (`packages/domain`, `packages/rpc`, `apps/api`) and the vendored Effect v4.0.5 at `repos/effect` — specifically `Data.ts` (`Data.TaggedError`), `sql/SqlError.ts` (the canonical `Schema.TaggedError` taxonomy + `isRetryable`), `rpc/Rpc.ts` (the `error` schema on `Rpc.make`), `rpc/RpcClientError.ts` (transport failures), and `http-api/HttpApiError.ts` (the `httpApiStatus` → HTTP status mapping).

---

## 1. The core mental model: two channels, one taxonomy

Effect separates two failure kinds, and the entire error model follows from keeping them apart:

| Kind | Channel | Meaning | Example |
|---|---|---|---|
| **Expected / typed error** | `Effect<A, E, R>` — the `E` in the effect signature, raised with `Effect.fail` | The caller is *expected* to handle it; it is part of the service contract and crosses the wire to the client as a typed value. | `ListItemNotFound`, `ValidationError`, `ConflictError`, `AuthError` |
| **Unexpected / defect** | the **defect** channel, raised with `Effect.die` / `Effect.orDie` | A bug or an invariant violation; the caller is *not* expected to handle it. It does **not** cross the wire as a typed value (it surfaces as a generic 500 / `RpcClientDefect`). | a SQL query that returns a malformed row, a null deref, an impossible enum value |

The scaffold already encodes this rule in `apps/api/src/list-item-service.ts`:

```ts
// Repository SqlError/SchemaError are unexpected (broken DB/query) → surfaced
// as defects (Effect.orDie); only the domain error stays in the error channel.
const setChecked = (id, checked) =>
  Effect.gen(function*() {
    const currentOpt = yield* repo.findById(id).pipe(Effect.orDie)
    if (Option.isNone(currentOpt)) {
      return yield* Effect.fail(new ListItemNotFound({ id }))   // typed error
    }
    // ...
  })
```

This draft **refines** that rule: it keeps domain errors typed, and it *promotes* "the DB is unreachable" from a raw defect into a typed `InfrastructureError` (see §3.3), because the client needs to distinguish "try again in a second" from "this will never work" (§3.4, DP-3). True bugs stay defects.

---

## 2. The shared error taxonomy (settled shape, enumerated)

Every expected failure the client can ever receive is one of a **small, closed set** of error *families*. Each family is a `Schema.TaggedError` (so it is both a runtime error with a `_tag` and a wire codec), and each carries the machine-readable fields the client needs to react. The families are:

| Family | `_tag` | Meaning | Carries | HTTP (plain-HTTP only) |
|---|---|---|---|---|
| `ValidationError` | `"ValidationError"` | input is structurally wrong or violates an invariant | `issues: Array<{ field, message }>` | `422` |
| `NotFoundError` | `"NotFoundError"` | the referenced aggregate / row does not exist (or isn't visible) | `entity: ItemType`, `id` | `404` |
| `ConflictError` | `"ConflictError"` | a write can't be applied because the row changed underneath (stale `baseVersion` / CAS miss) | `entity`, `id`, `currentVersion` | `409` |
| `AuthError` | `"AuthError"` | not authenticated (no / expired session) | `reason: "noSession" \| "expired"` | `401` |
| `ForbiddenError` | `"ForbiddenError"` | authenticated but not allowed (touching a spouse's `private` item) | `entity`, `id` (optional) | `403` |
| `RateLimitError` | `"RateLimitError"` | too many requests (medication-tier fire throttling, push flood) | `retryAfterMs` | `429` |
| `InfrastructureError` | `"InfrastructureError"` | something in the backend (D1, KV, DO) failed — **transient or permanent**, see §3.3 | `reason: InfraReason`, `isRetryable` | `503` (transient) / `500` (permanent) |

> **Deliberate scope note.** These seven families are the *wire* vocabulary. They do **not** replace per-aggregate precision at the service layer: a `HabitService` method can still raise `HabitNotFound extends NotFoundError` so callers get a specific `catchTag`. What travels across the wire is the *family* plus the fields — see DP-1 for the granularity tradeoff.

### 2.1 Three Effect idioms — when to use which

Effect v4 offers three overlapping ways to make a typed error; the taxonomy uses all three, deliberately:

```ts
import { Data, Schema } from "effect"

// (a) Data.TaggedError — a runtime error with a _tag, NO wire codec.
//     Use inside a service for errors that never leave the process
//     (or are collapsed into a wire family before serialization).
export class RecurrenceEnginePanic extends Data.TaggedError("RecurrenceEnginePanic")<{
  readonly rule: string
}> {}

// (b) Schema.TaggedError — a tagged error that IS ALSO a schema.
//     Use for the wire taxonomy: it encodes/decodes to JSON, so it can be
//     the `error` schema of an RPC and the body of a plain-HTTP error response.
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  { entity: ItemType, id: Schema.String }
) {}

// (c) Schema.Error — a schema error carrying an httpApiStatus annotation.
//     Use at the plain-HTTP edge to map an error to a status code.
export class AuthError extends Schema.Error<AuthError>("tali/AuthError")(
  { _tag: Schema.tag("AuthError"), reason: Schema.Literal("noSession", "expired") },
  { httpApiStatus: 401 }   // ← becomes the HTTP status
) {}
```

- `Data.TaggedError` → local, semantic failures (`Effect.catchTag`), never serialized directly.
- `Schema.TaggedError` → the shared wire taxonomy (idempotent JSON round-trip, discriminated by `_tag`).
- `Schema.Error` + `httpApiStatus` → the plain-HTTP edge (see §5), where an error must become an HTTP status code. This mirrors the vendored `HttpApiError.ts` exactly (`Unauthorized` → 401, `NotFound` → 404, `Conflict` → 409, …).

The canonical reference for the "taxonomy as `Schema.TaggedError`" shape is `repos/effect/packages/effect/src/sql/SqlError.ts`: one `TaggedError` per reason, a `Schema.Union` of the reasons, a single top-level wrapper, and an `isRetryable` getter.

---

## 3. How a service method declares its error type

A service method declares its contract as `Effect<A, E, R>` — success `A`, **error `E`** (the union of every typed failure it can raise), and requirements `R`. The `E` is the single source of truth: the compiler forces every handler and the RPC/HTTP edge to account for exactly `E`.

### 3.1 Service shape (explicit error union)

```ts
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  ItemType, HabitId,
  ValidationError, NotFoundError, ConflictError,
  AuthError, ForbiddenError, InfrastructureError
} from "@tali/domain"

// The closed union this service can fail with — part of its public type.
export type HabitServiceError =
  | ValidationError
  | NotFoundError      // a specific Habit not found (entity: "habit")
  | ConflictError      // stale version on update
  | InfrastructureError

export class HabitService extends Context.Service<HabitService>()("HabitService", {
  make: Effect.gen(function*() {
    // create: HabitInsert -> Effect<Habit, ValidationError | InfrastructureError>
    const create = (input: HabitInsert): Effect.Effect<Habit, ValidationError | InfrastructureError> =>
      Effect.gen(function*() {
        const habit = yield* parseHabitInsert(input)          // fails ValidationError
        return yield* habitRepo.insert(habit)                  // fails InfrastructureError (mapped from SqlError)
      })

    // complete: (HabitId, localDate) -> Effect<HabitEntry, HabitServiceError>
    const complete = (id: HabitId, date: string) =>
      Effect.gen(function*() {
        const habit = yield* habitRepo.findById(id)            // SqlError → InfrastructureError
        if (habit === undefined) {
          return yield* Effect.fail(new NotFoundError({ entity: "habit", id }))
        }
        return yield* habitRepo.upsertEntry({ habitId: id, date, status: "done" })
      })

    return { create, complete } as const
  })
}) {}
```

Two rules keep `E` honest and small:

1. **Never leak `SqlError` / `SchemaError` into `E`.** The repository's failure is *expected-but-infrastructure*; map it once at the repo boundary into `InfrastructureError` (see §3.3). Everything else that can't be named is a defect → `Effect.orDie`.
2. **Fail with the family, not a one-off string.** `Effect.fail(new NotFoundError({ entity: "habit", id }))` — never `Effect.fail(new Error("habit not found"))`, which would be an opaque defect.

### 3.2 Declaring `E` on the RPC (the wire contract)

`Rpc.make` takes an `error` schema; the default is `Schema.Never` ("this call cannot fail typed"). Listing `error` **makes the failure part of the client's type**, so web can't forget to handle it:

```ts
import { Rpc } from "effect/rpc"
import { HabitInsert, Habit, HabitServiceError, NotFoundError, ... } from "@tali/domain"

class CreateHabit extends Rpc.make("CreateHabit", {
  payload: HabitInsert,
  success: Habit,
  error: HabitServiceError            // ← declared, discriminated union
}) {}

class CompleteHabitEntry extends Rpc.make("CompleteHabitEntry", {
  payload: Schema.Struct({ id: HabitId, date: Schema.DateFromString }),
  success: HabitEntry,
  error: Schema.Union(NotFoundError, ConflictError, InfrastructureError)
}) {}
```

The scaffold already does this for one procedure (`CreateListItem` declares `error: ListItemNotFound`). This draft generalizes it: **every RPC declares its full error union**, and that union is built from the shared families (so it's narrow enough to be useful, wide enough to be complete).

---

## 4. Errors through `RpcGroup` to the client (typed failures)

### 4.1 How a typed error travels

Effect RPC carries success and failure in one discriminated `Exit` envelope (the `ndjson` HTTP transport in the scaffold). When a handler `Effect.fail`s with a `Schema.TaggedError`:

1. The server encodes the failure as the `Exit` failure payload using the RPC's `errorSchema`.
2. The client decodes it back into the **same typed error value** (`_tag` + fields), which becomes the `E` side of the client's `Effect`.
3. The client recovers by tag — the whole point of the taxonomy:

```ts
// apps/web — the derived client (already typed via ApiRpcs)
const result = yield* client("CreateHabit")(input).pipe(
  Effect.catchTags({
    ValidationError: (e) => showFieldErrors(e.issues),
    ConflictError: (e) => refreshThenRetry(e.id),
    InfrastructureError: (e) => e.isRetryable ? retryWithBackoff() : showServerDown()
  })
)
```

### 4.2 The transport failure channel (`RpcClientError`)

A typed error only exists if the *server handler ran*. Failures that happen before that — HTTP/network/socket errors, a malformed response, a decode failure — surface as **`RpcClientError`** (the type already threaded through the scaffold as `RpcClient.RpcClient<Rpcs, RpcClientError>`). Its `reason` union (`HttpClientError`, `SocketErrorReason`, `WorkerErrorReason`, `RpcClientDefect`) is the client's "the call didn't reach a handler" signal.

**Rule:** the client's per-call error type is therefore `DeclaredError | RpcClientError`. `RpcClientError` maps to the same `InfrastructureError`-like retry decision the client already makes (transient → retry, permanent → surface). Do **not** try to fold `RpcClientError` into the declared error schema — it's orthogonal (transport vs domain) and the RPC library owns it.

### 4.3 RPC does **not** use HTTP status codes for typed errors

The RPC HTTP transport returns `200` for a well-formed request whose handler failed with a *typed* error — the failure lives in the envelope, not the status line. HTTP status codes are only meaningful at the **plain-HTTP** edge (§5). Keep this in mind so nobody "adds a 404 to an RPC": that's what the `error` schema is for.

---

## 5. Plain-HTTP sync/SSE error encoding

Sync (`GET /sync/pull`, `POST /sync/push`, `GET /sync/bootstrap`) and the SSE wake channel are plain HTTP (settled in #8, transport decision 6). Here an error **must** become an HTTP status + JSON body, because there is no RPC envelope to carry a typed value.

### 5.1 The common wire envelope

Every non-2xx plain-HTTP response is one envelope shape, shared across sync and SSE:

```ts
// packages/domain — the one error envelope every plain-HTTP error uses
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,        // stable, client-facing code, e.g. "STALE_CURSOR"
    message: Schema.String,     // human-readable, NON-localized (see DP-4)
    retryable: Schema.Boolean,  // client may retry immediately/with backoff
    details: Schema.Record({ key: Schema.String, value: Schema.Unknown }) // machine params
  })
})
```

Concrete example — `GET /sync/pull?cursor=<too-old>`:

```json
HTTP/1.1 409 Conflict
{ "error": {
    "code": "STALE_CURSOR",
    "message": "Change feed cursor predates the retained window",
    "retryable": true,
    "details": { "cursor": 12, "minRetained": 4001 }
} }
```

`retryable: true` is deliberate: a stale cursor is *recoverable* by re-bootstrapping, which the client does automatically — so the "error" is really a redirect to `/sync/bootstrap`. This matches #8's `resetRequired` flag, here surfaced as the canonical error shape (see DP-5 for whether it should be an error at all).

### 5.2 Family → HTTP status mapping (plain-HTTP only)

| Family / code | HTTP status | Envelope `code` example |
|---|---|---|
| `ValidationError` | `422` | `VALIDATION` |
| `NotFoundError` | `404` | `NOT_FOUND` |
| `ConflictError` | `409` | `CONFLICT` / `STALE_CURSOR` |
| `AuthError` | `401` | `NO_SESSION` / `SESSION_EXPIRED` |
| `ForbiddenError` | `403` | `FORBIDDEN` |
| `RateLimitError` | `429` | `RATE_LIMITED` |
| `InfrastructureError` (transient) | `503` | `DB_UNAVAILABLE` |
| `InfrastructureError` (permanent) | `500` | `DB_CORRUPT` |

### 5.3 SSE wake channel

The SSE channel's only job is to *wake* (nudge, not data — #8 DP-6). Its error surface is correspondingly tiny: on connection it either opens (200, `text/event-stream`) or fails with a plain-HTTP error (401 `NO_SESSION`, 403 `FORBIDDEN`, 503 `UNAVAILABLE`). Once open, an unexpected stream termination is *not* an error envelope — the client treats a dropped SSE connection as "reconnect and pull", exactly as it treats a missed poll tick. No per-event error codes are needed.

---

## 6. Minimal code sketch (Effect v4 idioms from the vendored source)

```ts
// ── packages/domain/src/error.ts ──────────────────────────────────────────
import { Data, Schema } from "effect"

// (shared) infra reason union — mirrors SqlError.ts's reason taxonomy
export class DbUnavailable extends Schema.TaggedError<DbUnavailable>()("DbUnavailable", {
  cause: Schema.Defect()
}) { get isRetryable(): boolean { return true } }

export class DbCorrupt extends Schema.TaggedError<DbCorrupt>()("DbCorrupt", {
  cause: Schema.Defect()
}) { get isRetryable(): boolean { return false } }

export const InfraReason = Schema.Union(DbUnavailable, DbCorrupt)

export class InfrastructureError extends Schema.TaggedError<InfrastructureError>()(
  "InfrastructureError",
  { reason: InfraReason }
) {
  get isRetryable(): boolean { return this.reason.isRetryable }
}

// the shared wire families (one per §2 row)
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  issues: Schema.Array(Schema.Struct({ field: Schema.String, message: Schema.String }))
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: ItemType, id: Schema.String
}) {}

export class ConflictError extends Schema.TaggedError<ConflictError>()("ConflictError", {
  entity: ItemType, id: Schema.String, currentVersion: Schema.Int
}) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  reason: Schema.Literal("noSession", "expired")
}) {}

export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()("ForbiddenError", {
  entity: ItemType, id: Schema.String
}) {}

export class RateLimitError extends Schema.TaggedError<RateLimitError>()("RateLimitError", {
  retryAfterMs: Schema.Int
}) {}

// The one closed wire union every RPC/HTTP edge can reference.
export const WireError = Schema.Union(
  ValidationError, NotFoundError, ConflictError, AuthError,
  ForbiddenError, RateLimitError, InfrastructureError
)
export type WireError = Schema.Schema.Type<typeof WireError>
```

```ts
// ── packages/sql (repo boundary): map SqlError → InfrastructureError ───────
import { SqlError } from "effect/sql"

const mapSqlError = (e: SqlError): InfrastructureError =>
  e.isRetryable
    ? new InfrastructureError({ reason: new DbUnavailable({ cause: e }) })
    : new InfrastructureError({ reason: new DbCorrupt({ cause: e }) })

// habitRepo.insert(habit) : Effect<Habit, SqlError | SchemaError>
//   becomes, at the service boundary:
const insert = habitRepo.insert(habit).pipe(
  Effect.mapError((e) => e instanceof SqlError ? mapSqlError(e) : mapSqlError(new SqlError({ reason: e })))
)
```

```ts
// ── packages/rpc/src/api.ts: declare the error union per RPC ───────────────
class CreateHabit extends Rpc.make("CreateHabit", {
  payload: HabitInsert,
  success: Habit,
  error: Schema.Union(ValidationError, InfrastructureError)
}) {}

class CompleteHabitEntry extends Rpc.make("CompleteHabitEntry", {
  payload: Schema.Struct({ id: HabitId, date: Schema.DateFromString }),
  success: HabitEntry,
  error: Schema.Union(NotFoundError, ConflictError, InfrastructureError)
}) {}
```

```ts
// ── apps/api (plain-HTTP sync edge): error → status ────────────────────────
import { HttpRouter, HttpServerResponse } from "effect/http"

const toStatus = (err: WireError): number => {
  switch (err._tag) {
    case "ValidationError": return 422
    case "NotFoundError": return 404
    case "ConflictError": return 409
    case "AuthError": return 401
    case "ForbiddenError": return 403
    case "RateLimitError": return 429
    case "InfrastructureError": return err.isRetryable ? 503 : 500
  }
}

const syncPull = Effect.gen(function*() {
  // ... cursor too old? fail(new ConflictError(...)) — handled by the router's
  // catch-all below, which renders the envelope + status.
}).pipe(
  Effect.catchAll((err: WireError) =>
    HttpServerResponse.json(
      { error: { code: codeFor(err), message: defaultMessage(err), retryable: isRetryable(err), details: detailsOf(err) } },
      { status: toStatus(err) }
    )
  )
)
```

---

## 7. Open decision points (HITL — the humans settle these)

Each is a crisp question with a recommendation. **These are the real decisions this draft surfaces.**

- **DP-1 — How granular is the error union per service: one shared family union, or a per-aggregate `XNotFound`/`XConflict` taxonomy?**
  *Recommendation:* **both, layered.** Internally (service → service, in-process) use specific errors (`HabitNotFound`, `ListNotFound`) as `Schema.TaggedError`s so `catchTag` is precise. At the **wire boundary** (RPC `error` schema, HTTP envelope) collapse to the **shared family union** (`NotFoundError { entity, id }`). The family carries the discriminator the client needs (`entity: "habit"`, `id`); per-aggregate classes are a server-only refinement. This keeps the client's error-handling surface small (7 families, not ~40 classes) while preserving in-process precision.

- **DP-2 — Does RPC carry a discriminated-union error, or a generic `{ status, code }` envelope?**
  *Recommendation:* **discriminated union on RPC** (the `error` schema on `Rpc.make`), **`{ status, code }` envelope on plain HTTP only.** RPC already gives typed failures for free (the Exit envelope + `errorSchema`), and typed `catchTags` is the entire point of Effect RPC — flattening to a status/code envelope would throw away the compiler-checked recovery. Plain HTTP has no envelope, so it gets the status + code + details body. The two surfaces coexist; they encode the *same* seven families.

- **DP-3 — How does the client recover/retry on transient vs permanent errors?**
  *Recommendation:* **bake retryability into the error, not into ad-hoc status inspection.** Every wire error carries an explicit retry signal: `InfrastructureError.isRetryable` (transient `DbUnavailable` → retry, permanent `DbCorrupt` → stop), `ConflictError` → "re-pull then retry once", `RateLimitError.retryAfterMs` → schedule, `AuthError` → re-auth (no blind retry). The client holds one shared `retryPolicy(err)` that maps family + retryability → a `Schedule` (exponential backoff, capped). This is the `isRetryable` getter pattern from `SqlError.ts`, promoted to the whole taxonomy. Transient → automatic retry; permanent → surface to the user, never loop.

- **DP-4 — Where are error messages localized: server or client?**
  *Recommendation:* **client-localizes; server sends structured codes + machine params only.** The server emits a stable `code` + `details` (field names, ids, retry windows) and a *non-localized* English fallback `message` for logs/dev-tools. The web client maps `code` → localized copy (Persian for the MVP), and can highlight a field from `details`. Rationale: the two users are both Persian-speaking, but message copy is a product concern that changes faster than the wire contract; shipping copy in the client avoids a server deploy per wording tweak and keeps `domain` free of UI strings. *Open sub-question:* ship only `fa`, or `fa` + `en` from day one? (Recommend **`fa` only** for the MVP; add a locale table later.)

- **DP-5 — Are sync conflict/stale-cursor outcomes *errors*, or first-class result variants?**
  *Recommendation:* **first-class result variants** for the per-item conflict/tombstone/already-applied outcomes (#8 already models these as `_tag`'d `SyncPushResult`s) — they are *successful* responses describing a resolved conflict, not failures. Reserve the error channel for the genuinely-error cases: malformed request (`ValidationError` 422), bad auth (`AuthError` 401), stale *cursor* on pull (`ConflictError` 409 → client re-bootstraps), and infra. So a `409 STALE_CURSOR` is an error, but a `SyncPushResult("conflict")` is not. This keeps the "did my write work" answer in the happy channel where the client already expects it.

- **DP-6 — Do infrastructure/DB errors live in the typed error channel, or as defects?**
  *Recommendation:* **a single typed `InfrastructureError` in the channel** (with the transient/permanent `InfraReason` split), **defects reserved for true bugs.** The scaffold currently `orDie`s `SqlError`, which means the client can't tell "DB briefly unreachable" (retry) from "hard 500" (stop) — the two most different client behaviors. Promoting infra to a typed family gives the client that signal without forcing it to understand `SqlError`. *Consequence to accept:* the service `E` unions all grow by one member; that's the price of honest contracts.

- **DP-7 — `ValidationError` shape: pass through `SchemaError` issues, or a flattened `{ field, message }` list?**
  *Recommendation:* **flattened `{ field, message }` list** with stable per-field keys (e.g. `field: "title"`, `field: "recurrence.end"`), derived server-side from `SchemaError` via `TreeFormatter`/`ArrayFormatter`. Raw Schema issues are verbose, reference internals (AST paths, union indices) that can drift, and are hard for a client to map to a form input. Flattening at the edge gives the client exactly what it needs to highlight fields; the server still logs the raw issues for debugging.

---

## 8. What this draft deliberately does *not* decide

- **The exact `code` string registry** (the set of `"STALE_CURSOR"`, `"DB_UNAVAILABLE"`, … literals) — the *families* and the envelope shape are settled here; the literal strings are mechanical and can be listed when the endpoints land in Slice 1.
- **Retry schedule constants** (backoff base/delay/cap) — the *policy* (family + retryability → schedule) is settled; the numeric tuning is a hardening task.
- **Which errors are user-visible vs silently retried** — a product/Ux concern that rides on DP-3/DP-4 but isn't the shape of the model.
- **SSE reconnect/backoff details** — folded into DP-3's general retry policy; the specific SSE reconnect cadence is an implementation detail.
