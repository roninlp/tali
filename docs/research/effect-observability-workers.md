# Research: Effect observability (Tracer/Logger/Metrics) on Cloudflare Workers

**Ticket:** https://github.com/roninlp/tali/issues/14
**Question:** How do I wire Effect observability (Tracer/Logger/Metrics) on Cloudflare Workers so sync commits, push-dispatch latency, and reminder delivery are visible? Determine the idiomatic Effect v4 exports, what sinks work on Workers (console, Workers Analytics Engine bindings, or an external exporter), and a minimal production setup.
**Resolved:** 2026-10-16

---

## TL;DR (the decision)

Effect v4 ships a **self-contained, zero-dependency observability stack** under the `effect/observability` subpath, plus the stable `Logger`, `Tracer`, and `Metric` modules in the core `effect` package. On Cloudflare Workers there are three workable sinks, in order of recommendation:

1. **`console` / Workers Logs** — simplest. `Logger.consoleJson` (structured JSON lines) + the `Console` service. Flows to Workers Logs and `wrangler tail` for free. Best default for **logs**.
2. **Workers Analytics Engine binding** — the Cloudflare-native **metrics** sink. Effect has **no built-in WAE adapter**, so you write a small custom `Logger` (or `Tracer`) that calls `env.<BINDING>.writeDataPoint({ blobs, doubles, indexes })`. This is where "sync commits / reminder delivery" counts and "push-dispatch latency" histograms should land.
3. **External OTLP exporter** — `Otlp.layerJson(...)` / `Otlp.layerProtobuf(...)` piped over `FetchHttpClient.layer`. `FetchHttpClient` uses `globalThis.fetch`, so it runs on Workers. This is the idiomatic path to ship **traces + metrics + logs** to any OTLP collector (Honeycomb, Grafana Cloud, a self-hosted collector). **Caveat:** the exporter batches on a background fiber on a 5s interval, which a short-lived Worker invocation will never fire — you must `yield* OtlpExporter.Flusher.flush` (and await it) before returning the response, or spans/metrics are dropped.

**Idiomatic v4 exports** (all vendored in this repo, `effect@4.0.5`): `Logger`, `Tracer`, `Metric`, `Console` from `effect`; `Otlp`, `OtlpLogger`, `OtlpTracer`, `OtlpMetrics`, `OtlpSerialization`, `OtlpExporter` from `effect/observability`; `FetchHttpClient` from `effect/http`.

---

## 1. The Effect v4 observability surface (idiomatic exports)

### 1.1 Package layout

Observability is split across two places in the vendored `effect` package:

- **Core, stable** (in `effect`): `Logger`, `Tracer`, `Metric`, `Console`, `LogLevel`. These are the models + recording APIs the app code uses.
- **Exporters, unstable** (in `effect/observability`): `Otlp`, `OtlpLogger`, `OtlpTracer`, `OtlpMetrics`, `OtlpSerialization`, `OtlpExporter`, `PrometheusMetrics`. These turn the in-memory signals into wire format and ship them over HTTP.

Source: `repos/effect/packages/effect/src/observability/index.ts` (the barrel re-exports `Otlp`, `OtlpExporter`, `OtlpLogger`, `OtlpMetrics`, `OtlpResource`, `OtlpSerialization`, `OtlpTracer`, `PrometheusMetrics` — each marked `@stability unstable`, `@since 4.0.0`).

The `opentelemetry` package (`repos/effect/packages/opentelemetry/`) is a **separate, optional** integration with the `@opentelemetry/*` SDKs (`WebSdk.ts`, `NodeSdk.ts`). On Workers it is the wrong tool: `WebSdk` is browser-oriented (`@opentelemetry/sdk-trace-web`) and pulls in the OTel SDK dependency tree. Use `effect/observability` (zero deps) instead.

### 1.2 Logger (`effect/Logger`)

`Logger<Message, Output>` turns a log event into output (a string, an object, a console write, a data point). The recording surface is `Effect.log` / `logInfo` / `logWarning` / `logError` / `logDebug` / `logTrace` / `logFatal`.

- `Logger.make` (line 482) — build a custom logger from `(options) => output`.
- `Logger.layer(loggers, { mergeWithExisting })` (line 1056) — installs one or more loggers for an effect; the loggers may be `Logger` values **or** `Effect`s (so a WAE logger can `yield*` its binding).
- `Logger.defaultLogger` (line 501), `Logger.consoleLogFmt` (942), `Logger.consoleStructured` (968), `Logger.consoleJson` (992) — pre-built console sinks. `consoleJson` emits one JSON line per event via `console.log`, which Workers Logs ingests as structured fields.
- `Logger.withLeveledConsole` (line 369) — routes a `Logger` to `console.debug/info/warn/error` by level.
- Log-level filter: `References.MinimumLogLevel` (`repos/effect/packages/effect/src/References.ts` line 361), a `Context.Reference` you provide with `Layer.succeed(References.MinimumLogLevel, LogLevel.Info)`.

Source: `repos/effect/packages/effect/src/Logger.ts` (module docstring + the line references above).

### 1.3 Tracer (`effect/Tracer`)

`Tracer` is a `Context.Reference` (`repos/effect/packages/effect/src/Tracer.ts` line 653) with a `nativeTracer` default (line 670) that creates in-memory spans and exports nothing. To attach spans to your code:

- `Effect.withSpan(name, options)` (`repos/effect/packages/effect/src/Effect.ts` line 8580) — wrap an effect in a named span; span start/end timing is captured, so span duration **is** your latency signal.
- `Effect.withParentSpan` (8657), `Effect.withTracer` (8159), `Effect.withTracerEnabled` (8189), `Effect.withTracerTiming` (8214).
- `Effect.annotateSpans` (8246) / `Effect.annotateCurrentSpan` (8289) — attach key/value attributes to the active span.
- Install a backend with `Effect.provideService(Tracer.Tracer, tracer)` or a `Layer` that provides `Tracer.Tracer`. `OtlpTracer.layer(...)` does exactly this (see §3.3).

A custom tracer is just `Tracer.make({ span: (options) => new SpanImpl(...) })` (line 470) — see the WAE span example in §5.

### 1.4 Metrics (`effect/Metric`)

`Metric<Input, State>` is a **pull** model: metrics are registered in the `MetricRegistry` `Context.Reference` (line 1665) and later snapshotted (`Metric.snapshot` line 2964, `Metric.snapshotUnsafe` line 3093). Exporters read the snapshot; there is no built-in "push to `<vendor>`" metric sink other than OTLP/Prometheus.

- Constructors: `Metric.counter` (2102), `Metric.gauge` (2189), `Metric.frequency` (2284), `Metric.histogram` (2364), `Metric.summary` (2441), `Metric.timer` (2548).
- Tags/labels: `Metric.withAttributes` (2898).
- Recording: `Effect.track(metric, mapExit?)` (`repos/effect/packages/effect/src/Effect.ts` line 14432), or `Metric.modify` (2660) / `Metric.update` (2723).
- `Metric.value(metric)` (2609) reads a metric's aggregated state.
- Fiber runtime metrics (per-fiber counts/timings) are off by default; opt in with `Effect.enableRuntimeMetrics` / `Effect.disableRuntimeMetrics` (Effect.ts 3477 / 3507, `FiberRuntimeMetricsKey` Metric.ts 3276).

Because metrics are pull-based, on Workers the natural fit is **not** the OTLP metrics exporter (interval batching) but a **WAE sink**: a small `Effect` that snapshots the metrics you care about and calls `writeDataPoint` — see §5.

---

## 2. What sinks work on Cloudflare Workers

### 2.1 `console` → Workers Logs (logs)

Workers exposes `console.log/info/warn/error` and routes them to **Workers Logs** and `wrangler tail`. Effect's `Console` service (`effect/Console`) is the effectful wrapper (`Console.log` line 550, `Console.error` 413, `Console.warn` 749, etc.). For structured output use `Logger.consoleJson`.

- No setup beyond a `Logger.layer([Logger.consoleJson])`.
- This is the idiomatic **log** sink on Workers. Workers Logs also supports an `observability` config block for sampling/exports, but that is Cloudflare-side and independent of Effect.

Sources: `repos/effect/packages/effect/src/Console.ts`; https://developers.cloudflare.com/workers/observability/logs/workers-logs/

### 2.2 Workers Analytics Engine binding (metrics — Cloudflare-native)

WAE is a time-series store with **unlimited cardinality**, written from a Worker through a binding:

```jsonc
// wrangler.jsonc
{
  "analytics_engine_datasets": [
    { "binding": "TELEMETRY", "dataset": "tali_metrics" }
  ]
}
```

```js
env.TELEMETRY.writeDataPoint({
  blobs: ["sync_commit", "ok"],   // up to 20 string dimensions (labels)
  doubles: [1, 0.042],            // up to 20 numeric values
  indexes: ["user-123"]           // exactly 1 sampling key
})
```

- `writeDataPoint` is **fire-and-forget** (no `await`); the runtime writes in the background. You may also batch with `writeDataPoints([...])`.
- Limits: 20 blobs, 20 doubles, 1 index per data point; blobs ≤ 16 KB total; index ≤ 96 bytes; max 250 data points per Worker invocation; data retained 3 months.
- Effect has **no built-in WAE adapter** — the idiomatic approach is a custom `Logger` (or `Tracer`, or a metric-flush effect) that calls the binding. See §5.

Sources: https://developers.cloudflare.com/analytics/analytics-engine/get-started/ ; https://developers.cloudflare.com/analytics/analytics-engine/limits/

### 2.3 External OTLP exporter (traces + metrics + logs)

`effect/observability` ships OTLP/HTTP exporters that post to `/v1/traces`, `/v1/metrics`, `/v1/logs`. They require two services:

- `HttpClient.HttpClient` — the transport. On Workers use `FetchHttpClient.layer` (`repos/effect/packages/effect/src/http/FetchHttpClient.ts` line 132), which wraps `globalThis.fetch` (the Workers runtime `fetch`, so it respects subrequests/outbound rules).
- `OtlpSerialization` — `OtlpSerialization.layerJson` (line 54) or `layerProtobuf` (line 68). Prefer JSON on Workers (protobuf adds encode overhead for no benefit on the edge; JSON is also easier to eyeball in a local collector).

The one-call helpers are `Otlp.layerJson` / `Otlp.layerProtobuf` (`repos/effect/packages/effect/src/observability/Otlp.ts`), which build the combined logs + metrics + traces layer and require only `HttpClient`. Documented at https://effect.website/docs/v4/api/effect/observability/Otlp .

The canonical wiring (mirrors the vendored `ai-docs` example `20_otlp-tracing.ts`):

```ts
import { Otlp, OtlpSerialization } from "effect/observability"
import { FetchHttpClient } from "effect/http"
import { Layer } from "effect"

export const Observability = Otlp.layerJson({
  baseUrl: env.OTLP_ENDPOINT,          // e.g. https://api.honeycomb.io
  headers: { "x-honeycomb-team": env.HONEYCOMB_KEY },
  resource: { serviceName: "tali-worker", serviceVersion: "1.0.0" }
}).pipe(Layer.provide(FetchHttpClient.layer))
```

**The Workers lifetime problem (critical):** `OtlpExporter.make` buffers records and pushes them from a background fiber on a 5s interval (`OtlpTracer.make` line ~110: `exportInterval: options.exportInterval ?? Duration.seconds(5)`), and flushes "during scope finalization up to `shutdownTimeout`". A Cloudflare Worker invocation returns a `Response` and the isolate can be frozen/terminated right after — the 5s timer never fires, and scope finalization may not run to completion. **You must flush explicitly and await it before returning**, e.g.:

```ts
const program = Effect.gen(function*() {
  yield* doTheWork                    // spans/metrics/logs recorded here
  const flusher = yield* OtlpExporter.Flusher
  yield* flusher.flush                // drain traces+metrics+logs before returning
  return Response.json({ ok: true })
})
```

`Flusher.flush` (`repos/effect/packages/effect/src/observability/OtlpExporter.ts`) drains all registered exporters concurrently and cannot fail; bound it with `Effect.timeoutOption` so a slow collector can't stall the response.

Sources: `repos/effect/packages/effect/src/observability/OtlpExporter.ts`; `OtlpTracer.ts`; https://github.com/Effect-TS/effect/blob/main/ai-docs/src/08_observability/20_otlp-tracing.ts

---

## 3. Which signal goes where

| Signal | Best sink | Mechanism |
|---|---|---|
| Sync commit happened / failed | WAE `counter` (`blobs: ["sync_commit", status]`, `doubles: [1]`) | `Metric.counter` + a WAE flush effect, or a custom `Logger` |
| Push-dispatch latency | OTLP `span` duration, or WAE `histogram` (`doubles: [ms]`) | `Effect.withSpan("push.dispatch")` (+ `Otlp.layerJson`), or `Metric.histogram` + `Effect.track` |
| Reminder delivery count / latency / failures | WAE `counter`/`histogram` + OTLP span | `Effect.withSpan("reminder.deliver")` + `Effect.track(reminderDelivered)` |

The signal-specific mapping, in code:

```ts
const commitLatency = Metric.histogram("sync_commit_duration_ms", { unit: "ms" })
const commitsOk    = Metric.counter("sync_commits", { description: "commits applied" })

const syncCommit = (commit: Commit) =>
  Effect.succeed(applyCommit(commit)).pipe(
    Effect.withSpan("sync.commit", { attributes: { "commit.id": commit.id } }),
    Effect.track(commitLatency, (ms) => ms),   // duration via Effect duration
    Effect.tap(Effect.succeed(commitsOk).pipe(Effect.track(() => 1)))
  )
```

(For the latency value, `Effect.withSpan` already captures timing end-to-end and `OtlpTracer` exports it; a WAE histogram additionally needs the duration number, obtained with `Effect.timed` or `Effect.withClock`.)

---

## 4. Minimal production setup (WAE sink + console logs + optional OTLP)

This is the setup this research recommends: **console for logs, WAE for metrics, OTLP only if you have an external collector** (then skip WAE for metrics and add the flush).

```ts
import { Console, Effect, Layer, Logger, LogLevel, Metric, References } from "effect"
import type { Logger as Logger_ } from "effect"

// --- Workers bindings -----------------------------------------------------
interface Env {
  TELEMETRY: AnalyticsEngineDataset        // wrangler analytics_engine_datasets binding
  OTLP_ENDPOINT?: string                   // optional external OTLP collector
  OTLP_HEADERS?: Record<string, string>
}

// --- 1. A WAE logger: one Logger<unknown, void> that writes a data point ---
//    (Logger.layer accepts an Effect<Logger>, so the binding is read lazily.)
const waeLogger = (env: Env): Logger_.Logger<unknown, void> =>
  Logger.make((options) => {
    const level = options.logLevel
    env.TELEMETRY.writeDataPoint({
      blobs: ["log", level, String(options.message)],
      doubles: [1],
      indexes: [options.fiber.id()]
    })
  })

// --- 2. A custom Tracer that records span timing into WAE ----------------
//    (optional — only if you want span latencies in WAE rather than OTLP)
import * as Tracer from "effect/Tracer"
import * as Option from "effect/Option"

const waeTracer = (env: Env): Tracer.Tracer =>
  Tracer.make({
    span: (options) => {
      const started = options.startTime
      return {
        _tag: "Span",
        ...options,
        attribute: () => {},
        event: () => {},
        end(endTime, exit) {
          env.TELEMETRY.writeDataPoint({
            blobs: [options.name, exit._tag === "Success" ? "ok" : "error"],
            doubles: [Number(endTime - started) / 1e6],   // ns -> ms
            indexes: [options.name]
          })
        }
      } as any
    }
  })

// --- 3. The metrics used by the app --------------------------------------
export const SyncCommits = Metric.counter("sync_commits")
export const PushDispatchLatency = Metric.histogram("push_dispatch_ms", { unit: "ms" })
export const ReminderDelivered = Metric.counter("reminders_delivered")

// --- 4. Per-request wiring ------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Build the observability layer per request (bindings are cheap, and the
    // Worker isolate is short-lived, so no shared ManagedRuntime is required).
    const Observability = Logger.layer([
      Logger.consoleJson,                  // logs -> Workers Logs
      waeLogger(env)                       // logs -> WAE
    ]).pipe(
      Layer.provide(Layer.succeed(References.MinimumLogLevel, LogLevel.Info)),
      Layer.provideMerge(Layer.succeed(Tracer.Tracer, waeTracer(env)))
    )

    const program = Effect.gen(function*() {
      yield* Effect.logInfo("handling push", { path: new URL(request.url).pathname })
      yield* dispatchPush.pipe(Effect.withSpan("push.dispatch"), Effect.track(PushDispatchLatency))
      return Response.json({ ok: true })
    }).pipe(Effect.provide(Observability))

    return await Effect.runPromise(program)
  }
}
```

For the **external-collector** variant, swap the tracer layer for OTLP and remember the flush:

```ts
import { Otlp, OtlpExporter } from "effect/observability"
import { FetchHttpClient } from "effect/http"

const OtlpObs = Otlp.layerJson({
  baseUrl: env.OTLP_ENDPOINT!,
  headers: env.OTLP_HEADERS,
  resource: { serviceName: "tali-worker", serviceVersion: "1.0.0" }
}).pipe(Layer.provide(FetchHttpClient.layer))

const program = Effect.gen(function*() {
  yield* dispatchPush.pipe(Effect.withSpan("push.dispatch"))
  const flusher = yield* OtlpExporter.Flusher
  yield* flusher.flush.pipe(Effect.timeoutOption("2 seconds"))   // don't stall the response
  return Response.json({ ok: true })
}).pipe(Effect.provide(OtlpObs), Effect.provide(Logger.layer([Logger.consoleJson])))
```

---

## 5. Recommendation summary

| Need | Use |
|---|---|
| Logs (commit/reminder events) | `Logger.consoleJson` via `Logger.layer`, or `Logger.make` + `env.<B>.writeDataPoint` |
| Metrics (counts, histograms) | `Metric.counter` / `Metric.histogram` + `Effect.track`, exported by a WAE flush effect (Cloudflare-native) |
| Traces / latency | `Effect.withSpan` + `Otlp.layerJson` over `FetchHttpClient.layer` (external collector), or a custom `waeTracer` |
| Transport on Workers | `FetchHttpClient.layer` (wraps `globalThis.fetch`) |
| OTLP serialization | `OtlpSerialization.layerJson` (prefer over protobuf on the edge) |
| Log level filtering | `Layer.succeed(References.MinimumLogLevel, LogLevel.Info)` |
| OTLP + short-lived invocations | `yield* OtlpExporter.Flusher.flush` before returning the response |

**Packages / versions (as of writing):**
- `effect` **4.0.5** (vendored) — `effect/observability` (`Otlp`, `OtlpLogger`, `OtlpTracer`, `OtlpMetrics`, `OtlpSerialization`, `OtlpExporter`, `PrometheusMetrics`), `effect/http` (`FetchHttpClient`), and core `Logger` / `Tracer` / `Metric` / `Console`.
- No additional npm dependency is required for the console, WAE, or OTLP-JSON paths; the `@effect/opentelemetry` package is only needed if you must integrate with the `@opentelemetry/*` SDK ecosystem (not recommended on Workers).

**Sources:**
- Vendored: `repos/effect/packages/effect/src/{Logger,Tracer,Metric,Console,References,Effect}.ts`, `repos/effect/packages/effect/src/observability/*`, `repos/effect/packages/effect/src/http/FetchHttpClient.ts`, `repos/effect/packages/opentelemetry/src/{WebSdk,NodeSdk}.ts`.
- `effect/ai-docs` example (OTLP tracing + logging layer): https://github.com/Effect-TS/effect/blob/main/ai-docs/src/08_observability/20_otlp-tracing.ts
- Effect v4 API docs: https://effect.website/docs/v4/api/effect/observability/Otlp
- Cloudflare Workers Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/get-started/ and https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Cloudflare Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
