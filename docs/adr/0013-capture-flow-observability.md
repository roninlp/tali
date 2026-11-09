# 0013 — Capture flow observability and span redaction

Status: accepted

## Context

PR #102 merged the Capture flow (Dissect → review → Commit). In production an
operator could see that an RPC call happened, but not where its time went: the
model call, each D1 statement, and the commit were separate unknowns. Workers
Logs were on; Workers Traces were not. Effect ran with its native tracer, so
SQL and HTTP spans were created in memory and discarded.

Two facts constrained the design:

1. The api Worker is a plain module (`{ fetch, scheduled }`), not an
   Effect-native Alchemy Worker. `Cloudflare.Telemetry()` registers a tracer for
   an Effect-native handler and is not available here.
2. Foldkit wraps every Command in `Effect.withSpan(command.name, { attributes:
   command.args })`. For Capture those args contain the raw user text
   (`DissectCapture`) and the reviewed drafts (`CommitCapture`).

The model SDK also logs `rawArguments` at error level when a tool call is
malformed JSON. A development run printed the full Persian text, and Workers
Logs would have retained it.

## Decision

### Traces

`TaliApi` enables Workers Traces with head sampling, persistence, query-string
redaction, and logs kept on. The default rate is 10%, configurable with
`TALI_TRACE_SAMPLE_RATE`. A request that is sampled keeps its whole waterfall.

`TALI_TRACE_PROPAGATION=accept` is opt-in. It tells Cloudflare to adopt the
browser's incoming `traceparent`, which is what merges the Foldkit Command
spans and the api spans into one trace id. It requires the account-level trace
propagation feature.

An OTLP destination is opt-in through `TALI_OTLP_TRACES_URL` /
`TALI_OTLP_LOGS_URL`. It creates `Cloudflare.Workers.ObservabilityDestination`
resources and lists their slugs in the Worker's `traces.destinations` /
`logs.destinations`. No token is committed. Dashboard-only is the default.

### Server tracer

A small per-request Effect `Tracer` (`apps/api/src/cloudflare-tracer.ts`) mirrors
Effect spans into `cloudflare:workers` via `tracing.startActiveSpan`. It carries
the invocation's `AsyncLocalStorage` snapshot and re-enters a parent span's
snapshot for each child, because Effect's scheduler does not preserve the
platform's async context on its own.

`HttpMiddleware.tracer` is installed globally, so every route creates one
server span (`POST /rpc`, `GET /today`, …) and uses the incoming `traceparent`
as its parent.

Named spans in the Capture flow:

| Span | Attributes |
| --- | --- |
| `capture.dissect` | `capture.id`, `capture.chars`, `capture.outcome`, `capture.proposal_count`, `capture.error_tag` |
| `capture.model.call` | `capture.id`, `capture.model.name`, `capture.model.duration_ms`, `capture.outcome`, `capture.proposal_count` |
| `capture.commit` | `capture.id`, `capture.proposal_count`, `capture.commit.created_count`, `capture.commit.remaining_count`, `capture.outcome`, `capture.error_tag` |

Span duration is the timing record. `capture.model.duration_ms` is explicit
because the model run is the part whose latency was previously unknowable; the
Capture table keeps only `created_at` and `committed_at` and does not gain a
denormalized duration column.

D1 latency comes from the platform: every binding call is auto-instrumented,
so no SQL span attributes are added by this code. Cloudflare fills
`db.query.text` itself, outside the application filter, but every Capture
statement is parameterized, so the user text travels as a bind value rather
than as query text.

### Redaction

`@tali/telemetry` owns one policy for both runtimes:

- export is allow-by-prefix (`capture.`, `http.`, `url.`, `db.`, `server.`,
  `client.`, `network.`), plus `effect.exit`, `error.type`, and
  `exception.type`;
- any sensitive token in the key vetoes it even inside an allowed namespace
  (`text`, `title`, `body`, `quote`, `question`, `prompt`, `draft`, `args`,
  `message`, `query`, `statement`, `authorization`, `cookie`, `token`, …);
- only string, number, and boolean values are exported;
- URL attributes lose their query string and fragment.

The api tracer applies the filter when forwarding to Cloudflare. The browser
wraps `OtlpTracer` in `redactTracer`, which filters attributes, span links, and
event attributes, and replaces a failed span's cause with a fixed message so an
exception event cannot carry text. Foldkit Command names remain the span names
(`DissectCapture`, `CommitCapture`); its args never leave the browser.

The TanStack AI SDK logger is disabled (`debug: false`) on the Capture run.
Typed errors and spans carry the diagnosis: field name, outcome, duration,
error tag.

## Consequences

- One sampled capture can be followed end to end: request, Dissect, model call,
  commit, model `fetch`, and D1 statements.
- The dashboard is the default view and works without an external account.
- Browser Command spans are exported only when a build-time OTLP endpoint is
  configured. That endpoint and header are public; it must be a browser-scoped
  key.
- With trace propagation off, the browser and api traces share propagation ids
  but are stored as two traces in Workers Observability.
- Traces have seven-day retention. Persisted traces become billable on
  2026-12-01; the sample rate is the lever.
