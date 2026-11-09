import { Array, Duration, Effect, Layer, Option, Schema, Tracer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
  OtlpExporter,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability'

import { redactTracer } from '@tali/telemetry'

import { isDevServer } from './config'

/**
 * Browser trace export for the Foldkit runtime.
 *
 * Foldkit wraps every Command in `Effect.withSpan(command.name, { attributes:
 * command.args })`, and the Capture Commands carry the raw user text and the
 * reviewed drafts. `redactTracer` runs in front of the exporter, so only
 * `capture.*` / `http.*` style scalar attributes leave the browser. Without an
 * endpoint the layer is empty: spans stay in memory and the existing
 * `traceparent`/`b3` propagation still joins the api trace.
 *
 * The endpoint and headers are build-time `VITE_*` values. A header value is
 * visible in the bundle, so use a browser-scoped ingest key or a collector that
 * accepts public writes; never reuse a server token. The collector must also
 * answer the CORS preflight for `content-type` and any configured header.
 */

const endpoint = import.meta.env.VITE_OTLP_TRACES_URL?.trim()

const HeaderValues = Schema.Record(Schema.String, Schema.Unknown)

const asHeaderValues = Schema.decodeUnknownOption(
  Schema.fromJsonString(HeaderValues),
)

const asString = Schema.decodeUnknownOption(Schema.String)

const stringRecordOf = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === '') return undefined

  return Option.map(asHeaderValues(raw), record => {
    const entries = Array.reduce(
      Object.entries(record),
      Array.empty<readonly [string, string]>(),
      (acc, [key, value]) =>
        Option.match(asString(value), {
          onNone: () => acc,
          onSome: text => [...acc, [key, text] as const],
        }),
    )

    return Object.fromEntries(entries)
  }).pipe(Option.getOrUndefined)
}

const headers = stringRecordOf(import.meta.env.VITE_OTLP_TRACES_HEADERS)

const exporter = Layer.effect(
  Tracer.Tracer,
  OtlpTracer.make({
    url: endpoint ?? '',
    headers,
    resource: {
      serviceName: 'tali-web',
      attributes: {
        'deployment.environment': isDevServer ? 'development' : 'production',
      },
    },
    exportInterval: Duration.seconds(2),
    maxBatchSize: 100,
  }).pipe(Effect.map(redactTracer)),
).pipe(
  Layer.provide(OtlpExporter.layerFlusher),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(OtlpSerialization.layerJson),
)

export const tracingResources: Layer.Layer<never> =
  endpoint === undefined || endpoint === '' ? Layer.empty : exporter
