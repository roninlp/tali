# Research: Effect RPC + SolidStart server-function interop

Ticket: [#6](https://github.com/roninlp/tali/issues/6) — part of [#1](https://github.com/roninlp/tali/issues/1) (wayfinder map).

## Question

How do SolidStart server functions and Effect RPC share one set of `@effect/schema` codecs so the web app calls typed backend mutations with no drift? What is the idiomatic bridge, what are the SSR/streaming implications, and how do sync pull/push + SSE stay as plain HTTP alongside it?

## Answer (TL;DR)

**The `@effect/schema` schema *is* the codec, and the RPC contract *is* the type source.** There is no second codec or duplicated type anywhere:

1. **`packages/domain`** exports the `@effect/schema` schemas (the only mutual dependency between `web` and `api`, per the map's settled decision).
2. **`packages/rpc`** builds an `RpcGroup` from those schemas — a single typed contract read by *both* sides.
3. **The `api` app** serves that group over plain HTTP (`RpcServer.layerHttp`), decoding/encoding payloads, results, errors, and defects with the *same* schemas.
4. **The `web` app** imports the same group. The browser builds a typed client (`RpcClient.make` + `RpcClient.layerProtocolHttp`) and calls mutations directly. SolidStart `"use server"` functions are thin wrappers that reuse the *same* group so their argument/return types are derived from the shared schemas — never hand-written in parallel.

Effect RPC's client is **derived, not generated**: `RpcClient.RpcClient<Rpcs, E>` is a mapped type over the group, one method per RPC tag, with input/success/error types pulled from the schemas' `Type`/`Encoded` members. Because server and client both read the same `RpcGroup` value, drift is a type error at compile time, not a runtime concern.

---

## Sources of truth

**Effect** — vendored at `repos/effect/` (this repo treats it as authoritative per `AGENTS.md`). It is **Effect v4.0.5**, where RPC is unified into the `effect` package under the `effect/rpc` subpath (not the published 3.x `@effect/rpc` / `@effect/rpc-http` split — see [Naming note](#naming-note-effect-3x-vs-4x) below).

- `repos/effect/packages/effect/src/rpc/Rpc.ts` — the RPC contract type & `Rpc.make` / `Rpc.custom` constructors (schema-backed).
- `repos/effect/packages/effect/src/rpc/RpcGroup.ts` — `RpcGroup.make`, `toLayer`, `toLayerHandler`, `of`, `middleware`, type helpers (`Rpcs`, `HandlersFrom`).
- `repos/effect/packages/effect/src/rpc/RpcServer.ts` — `make`, `layer`, `layerHttp`, `layerProtocolHttp`, `toHttpEffect`.
- `repos/effect/packages/effect/src/rpc/RpcClient.ts` — `make`, `layerProtocolHttp`, `RpcClient.From` (derived client type), `withHeaders`.
- `repos/effect/packages/effect/src/rpc/RpcSerialization.ts` — `layerNdjson`, `layerJson`, `layerSchemaBinary`, `layerJsonRpc`, `layerNdJsonRpc`.
- `repos/effect/packages/effect/src/rpc/RpcTest.ts` — `RpcTest.makeClient` (in-process, no transport).
- `repos/effect/packages/platform/node/test/fixtures/rpc-schemas.ts` + `rpc-e2e.ts` — canonical end-to-end pattern (server, handlers, client, HTTP/WebSocket/TCP/worker transports, ndjson/json/schema-binary/json-rpc serialization).
- `repos/effect/packages/effect/src/http/HttpServerResponse.ts` — `stream()` for plain-HTTP SSE-style responses.

**SolidStart** — official docs (`docs.solidjs.com`), fetched Oct 2026:

- [`"use server"`](https://docs.solidjs.com/solid-start/v1/reference/server/use-server) — the directive; client builds turn references into RPC calls, SSR/server builds call them directly.
- [Serialization](https://docs.solidjs.com/solid-start/v1/advanced/serialization) — Seroval under the hood, `json` vs `js` modes, streaming payloads.
- [Data fetching](https://docs.solidjs.com/solid-start/v1/building-your-application/data-fetching) — server functions + `query`/`createAsync`, `deferStream`, "headers after streaming" constraint.
- [Data mutation](https://docs.solidjs.com/solid-start/v1/building-your-application/data-mutation) — server functions + `action`, single-flight mutations.
- [Returning responses](https://docs.solidjs.com/solid-start/v1/advanced/return-responses) — returning a `Response` from a server function.
- [Request events](https://docs.solidjs.com/solid-start/v1/advanced/request-events) — `getRequestEvent()` / `event.locals` / `nativeEvent` (H3).

---

## Effect RPC model (v4)

### The contract is schema-backed

An RPC procedure records its **payload schema, success schema, error schema, defect schema**, plus middleware and annotations (`Rpc.ts:76-173`). Constructing one:

```ts
import { Schema } from "effect"
import { Rpc } from "effect/rpc"

class CreateTask extends Rpc.make("CreateTask", {
  payload: { title: Schema.String, due: Schema.DateFromString },
  success: Schema.Struct({ id: Schema.UUID }),
  error: Schema.Struct({ _tag: Schema.Literal("ValidationError"), issues: Schema.Array(Schema.String) })
}) {}
```

The **schemas are the codecs**. `Rpc.exitSchema(rpc)` builds a `Schema.Exit<success, error, defect>` from them (`Rpc.ts:1169-1195`); the server decodes the payload and encodes success/error/defect with them, and the client does the mirror operation. Type derivation reads the same schema objects:

- `Rpc.Payload<R>`, `Rpc.Success<R>`, `Rpc.Error<R>` → the `Type` of each schema.
- `Rpc.PayloadConstructor<R>` → the `"~type.make.in"` input the payload constructor accepts.

### The group is shared state

`RpcGroup.make(...rpcs)` collects RPCs by tag into one value (`RpcGroup.ts:411-417`). It carries the type-level union `Rpcs` that drives both the handler type and the client type. The group is what server and client import in common.

### Server: mount over plain HTTP

`RpcServer.layerHttp` registers a route on the current `HttpRouter` and forks the RPC server (`RpcServer.ts:946-971`):

```ts
RpcServer.layerHttp({
  group: ApiRpcs,
  path: "/rpc",            // POST /rpc
  protocol: "http"         // plain HTTP (ndjson); default is "websocket"
})
```

Handlers are implemented with `group.toLayer({ Tag: handler })` (`RpcGroup.ts:97-110`). The handler receives the *decoded* payload (`Rpc.ToHandlerFn`, `Rpc.ts:661-670`) and returns an `Effect` (or `Stream` for `stream: true` RPCs).

### Client: derived, not generated

`RpcClient.make(group)` returns a typed client object (`RpcClient.ts:646-659`); `RpcClient.layerProtocolHttp({ url })` wires it to a base URL over `HttpClient` (`RpcClient.ts:1020-1029`). The client type is the mapped type `RpcClient.RpcClient<Rpcs, E>` — one method per tag, returning `Effect` (or `Stream` for streaming RPCs) with types derived from the schemas (`RpcClient.ts:87-143`).

There is **no codegen step** — the "generation" is a TypeScript mapped type over the shared group.

---

## SolidStart server functions model

- **`"use server"`** is the compiler directive (`use-server.mdx`). In **client builds**, the reference is transformed into an RPC call (network fetch with serialized args); in **SSR/server-function builds**, the function body runs directly in the server runtime. The same source function therefore has two "resolutions".
- **Arguments and return values are serialized** with **Seroval**, streamed to keep responses responsive (`serialization.mdx`). Modes: `json` (JSON.parse, CSP-safe, v2 default) vs `js` (Seroval JS, smaller, needs `unsafe-eval`, v1 default). Depth cap 64 in json mode.
- Server functions compose with **`query`** (data fetching) and **`action`** (mutation), and support **single-flight mutations**: one POST that performs the action *and* revalidates/re-streams preloaded queries (`data-mutation.mdx`).
- **Streaming constraint**: once the SSR response begins streaming, headers/cookies/status are fixed — so redirects or cookie-setting `useSession` must run before streaming, or you opt out with `createAsync(..., { deferStream: true })` (`data-fetching.mdx`).
- A server function may **return a `Response`** (`return-responses.mdx`), which is the escape hatch for SSE-style endpoints.

The key interop fact: **a `"use server"` function's public signature is the only contract the client sees.** If that signature is written by hand in parallel with Effect schemas, you have two sources of truth and drift is possible. The bridge below makes the schema the single source and lets the server-function signature be *derived* from it.

---

## The concrete bridge

### 1. `packages/domain` — the schemas (single source of truth)

```ts
// packages/domain/src/task.ts
import { Schema } from "effect"

export class TaskId extends Schema.UUID.pipe(Schema.brand("TaskId")) {}

export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  title: Schema.String,
  due: Schema.OptionFromNullOr(Schema.DateFromString),
  completed: Schema.Boolean
}) {}

export class CreateTaskInput extends Schema.Struct({
  title: Schema.String,
  due: Schema.OptionFromNullOr(Schema.DateFromString)
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  issues: Schema.Array(Schema.String)
}) {}
```

This is the only package both `web` and `api` are allowed to depend on (per the map).

### 2. `packages/rpc` — the contract

```ts
// packages/rpc/src/api.ts
import { Rpc, RpcClient, RpcGroup } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { CreateTaskInput, Task, TaskId, ValidationError } from "@tali/domain"

class CreateTask extends Rpc.make("CreateTask", {
  payload: CreateTaskInput,
  success: Task,
  error: ValidationError
}) {}

class CompleteTask extends Rpc.make("CompleteTask", {
  payload: { id: TaskId },
  success: Task
}) {}

export const ApiRpcs = RpcGroup.make(CreateTask, CompleteTask)

// The derived, shared type the web app imports:
export type ApiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof ApiRpcs>, RpcClientError>
```

### 3. `api` app — serve it

```ts
// apps/api/src/rpc-layer.ts
import { RpcServer, RpcSerialization } from "effect/rpc"
import { ApiRpcs } from "@tali/rpc"

export const RpcLayer = RpcServer.layerHttp({
  group: ApiRpcs,
  path: "/rpc",
  protocol: "http"          // plain HTTP POST /rpc, ndjson-framed
}).pipe(
  Layer.provide(ApiRpcs.toLayer({
    CreateTask: (input) => /* Effect<Task, ValidationError> */ Effect.succeed(new Task({...})),
    CompleteTask: ({ id }) => /* ... */
  })),
  Layer.provide(RpcSerialization.layerNdjson)
)
```

`HttpRouter.serve(RpcLayer)` (as in `repos/effect/packages/platform/node/test/RpcServer.test.ts:25-34`) mounts it. NDJSON (`application/ndjson`) is the serialization that works over a plain HTTP POST body without message framing — required for streaming RPCs over HTTP; `layerJson` is for framed transports (WebSocket), `layerSchemaBinary` is the compact binary codec with optional payload fingerprints.

### 4. `web` app — call it (client + server functions)

**Client-side (browser → api over plain HTTP):**

```ts
// apps/web/src/lib/rpc.ts
import { RpcClient } from "effect/rpc"
import { FetchHttpClient } from "effect/http"
import { ApiRpcs } from "@tali/rpc"

export const ApiClientLayer = Layer.effect(ApiClientTag)(
  RpcClient.make(ApiRpcs)
).pipe(
  Layer.provide(RpcClient.layerProtocolHttp({ url: "/rpc" })), // same-origin; api is reverse-proxied
  Layer.provide(FetchHttpClient.layer)
)
```

Then `const client = yield* ApiClientTag; yield* client.CreateTask({ title: "…", due: Option.some(new Date()) })` is fully typed, with `ValidationError` in the error channel.

**Server-side (`"use server"` functions) — two resolutions, one contract:**

Because `"use server"` already compiles to an RPC call on the client, the *idiomatic* choice is to **not re-implement mutation logic in the server function**. Instead the server function is a thin, typed adapter over the *same* contract:

```ts
// apps/web/src/server/tasks.ts
import "server-only"          // optional; guarantees server-only imports don't leak to the client bundle
import { CreateTaskInput } from "@tali/domain"
import { ApiRpcs } from "@tali/rpc"

// Return type is Schema.Type<Task> — derived, not hand-written.
export async function createTask(input: CreateTaskInput) {
  "use server"
  // (a) in-process if api is colocated (not on Workers), or
  // (b) server-to-server: a node HttpClient client pointed at the api Worker.
  return callRpc(ApiRpcs, "CreateTask", input)
}
```

Two concrete resolution strategies, both keeping one codec set:

1. **Server-to-server HTTP** (the norm on Cloudflare Workers, where `web` and `api` are separate Workers): the server function builds the same `RpcClient` with a node `HttpClient` pointed at the api's internal URL. One contract, one extra hop during SSR.
2. **In-process** (dev / tests / if colocated): `RpcTest.makeClient(ApiRpcs)` or `ApiRpcs.accessHandler("CreateTask")` invokes the handler directly with no transport and no serialization (`RpcTest.ts:28-58`).

**Form/action ergonomics** ride on top: wrap the same call in an `action(..., "createTask")` so the client gets Solid Router's pending/error state and single-flight revalidation — the RPC contract underneath stays unchanged.

### Why this gives "no drift"

- The **wire codec** and the **TypeScript type** are one object (the `@effect/schema` schema). Server encodes with it, client decodes with it, both type-check against the same `.Type`/`.Encoded`.
- The **procedure map** (`RpcGroup`) is one value imported by both `api` and `web`. Adding a procedure updates the handler type *and* the client type in the same edit; forgetting a handler is a compile error, and calling a non-existent method is a compile error.
- `SchemaBinary` with `fingerprintPayloads: true` additionally detects a schema *mismatch at runtime* as a "matching layout fingerprint" defect rather than a corrupt payload (`RpcServer.test.ts:36-57`).

---

## SSR / streaming implications

1. **Server functions run during SSR on the server.** If they call the api over HTTP, that is a **server→server fetch inside render**. On Workers this is a fetch across Workers (fast, but not free — account for it; prefer in-process when colocated). Keep SSR fetches off the critical path or gate with `createAsync`/`deferStream`.

2. **Header/status mutation is closed once SSR streaming starts** (`data-fetching.mdx`). Any server function that sets cookies, throws `redirect`, or writes headers must finish before the first streamed byte, or use `{ deferStream: true }`. This matters if auth (session cookies) flows through a server function that also calls RPC.

3. **Streaming RPC ≠ server-function return serialization.** A streaming RPC (`Rpc.make(..., { stream: true })`) returns an Effect `Stream` and is delivered over HTTP as **ndjson chunks** (`RpcServer.ts:1240-1269`). SolidStart server functions serialize a *single* return value via Seroval — they cannot relay a live stream. So **streaming RPC must be consumed directly by the browser client**, never funneled through a `"use server"` function. Use it for server-push that needs typed, cancellable, backpressured streams (e.g. live re-render of a week as edits land). It is *not* a substitute for SSE.

4. **Serialization-mode mismatch.** Effect RPC's own serialization (ndjson/json/schema-binary) and SolidStart's Seroval (`json`/`js`) are *independent* layers on *different* boundaries (RPC ↔ api; server-function ↔ client). Don't try to unify them. Pick Seroval `json` for CSP-safety (v2 default); it has a 64-depth cap, so keep server-function return values flat.

---

## Sync pull/push + SSE stay plain HTTP

Per the map's settled decision: **"Effect RPC for aggregate CRUD/mutations; plain HTTP for sync pull/push + SSE streams."** They coexist because they solve different shapes:

- **Sync pull/push** is bulk, cursor-based, last-write-wins — a `GET /sync?since=<cursor>` returning a flat delta and a `POST /sync` accepting one. There is no per-procedure typed contract to share, and the payload is a single opaque envelope, so RPC adds ceremony with no benefit. Define the *envelope* schema in `packages/domain` (so `api` validates and `web` parses with the same codec), but transport it as plain HTTP endpoints.

- **SSE** is a one-directional, server-initiated event stream (reminder due, missed-reminder inbox). Effect's plain-HTTP primitive is `HttpServerResponse.stream(stream: Stream<Uint8Array, E>)` (`HttpServerResponse.ts:469-487`); SolidStart's equivalent is returning a `Response` with a `ReadableStream` from an API route / `GET` handler (`return-responses.mdx`). Neither needs RPC's request/response, ack, or typed-stream machinery.

The shared piece is still `packages/domain`: the sync envelope and the SSE event payloads are `@effect/schema` schemas used on both sides for validation/decoding, even though the transport is plain HTTP rather than RPC.

---

## Naming note: Effect 3.x vs 4.x

The ticket and the map say `@effect/platform`. The vendored source of truth is **Effect 4.0.5**, where RPC moved *into* `effect`:

| Concept | Effect 3.x (published) | Effect 4.x (vendored, authoritative here) |
| --- | --- | --- |
| Contract | `@effect/rpc` `Rpc` / `RpcGroup` | `effect/rpc` (`Rpc`, `RpcGroup`) |
| HTTP server | `@effect/rpc-http` `HttpRpcRouter.toHttpApp` | `effect/rpc` `RpcServer.layerHttp` / `toHttpEffect` |
| HTTP client | `@effect/rpc-http` `HttpRpcClient` | `effect/rpc` `RpcClient.layerProtocolHttp` |
| HTTP layer | `@effect/platform` `HttpApi` / `HttpRouter` | `effect/http` (`HttpRouter`, `HttpServer`, `HttpClient`, `FetchHttpClient`) |

Code in this repo should follow the **4.x** names above. (If the app is ever pinned to 3.x instead, the same bridge applies with `@effect/rpc` + `@effect/rpc-http` + `@effect/platform`; only the import paths and the `HttpRpcRouter` name change.)

---

## Decisions the map should record / remaining fog

- **Primary pattern**: Effect RPC as the client's mutation surface (Pattern A), with `"use server"` functions reserved for SSR data loading and form/action single-flight — delegating to the same `packages/rpc` group, *not* re-declaring types. (This is the recommendation; confirm against HITL.)
- **Server-function resolution**: server-to-server HTTP (Workers reality) vs in-process `RpcTest`/`accessHandler` for dev/tests.
- **Serialization**: `ndjson` for HTTP RPC (streaming-capable), `schema-binary` as the size optimization; confirm whether payload fingerprinting is enabled for drift detection.
- **SSE transport**: Effect `HttpServerResponse.stream` vs a SolidStart `Response` stream — pick one owner for the SSE endpoint (leaning api-side, since push/notifications live there).

## See also

- Map (#1) settled decisions — stack, transport, `packages/domain` as sole shared dep.
- `docs/must-have-feature-map.html`, `docs/product-requirements-v2.html` — scope authority.
