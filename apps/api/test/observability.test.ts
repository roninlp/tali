import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vite-plus/test'
import { Layer, String as Str, Tracer } from 'effect'
import { D1Client } from '@effect/sql-d1'
import { HttpRouter } from 'effect/http'
import { makeAppLayer } from '../src/http-layer.js'
import { FakeD1 } from './fake-d1.js'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_SPAN_ID = '00f067aa0ba902b7'

const recordingTracer = (spans: Array<Tracer.NativeSpan>): Tracer.Tracer =>
  Tracer.make({
    span: options => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })

describe('api Worker tracing', () => {
  it('creates a global server span and continues the inbound traceparent', async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const db = new FakeD1(new DatabaseSync(':memory:'))
    const layer = makeAppLayer({ tracer: recordingTracer(spans) }).pipe(
      Layer.provide(
        D1Client.layer({
          db: db.asD1Database(),
          transformQueryNames: Str.camelToSnake,
          transformResultNames: Str.snakeToCamel,
        }),
      ),
    )
    const { handler, dispose } = HttpRouter.toWebHandler(layer, {
      disableLogger: true,
    })

    try {
      const response = await handler(
        new Request('http://localhost/health', {
          headers: {
            traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
          },
        }),
      )
      expect(response.status).toBe(200)
    } finally {
      await dispose()
    }

    const serverSpan = spans.find(span => span.name === 'GET /health')
    expect(serverSpan).toBeDefined()
    expect(serverSpan!.traceId).toBe(TRACE_ID)
    expect(serverSpan!.parent).toMatchObject({
      value: { spanId: PARENT_SPAN_ID },
    })
    const attributes = Object.fromEntries(serverSpan!.attributes)
    expect(attributes['http.request.method']).toBe('GET')
    expect(attributes['http.response.status_code']).toBe(200)
  })

  it('does not install tracing without a tracer', async () => {
    const db = new FakeD1(new DatabaseSync(':memory:'))
    const layer = makeAppLayer().pipe(
      Layer.provide(
        D1Client.layer({
          db: db.asD1Database(),
          transformQueryNames: Str.camelToSnake,
          transformResultNames: Str.snakeToCamel,
        }),
      ),
    )
    const { handler, dispose } = HttpRouter.toWebHandler(layer, {
      disableLogger: true,
    })

    try {
      const response = await handler(new Request('http://localhost/health'))
      expect(response.status).toBe(200)
    } finally {
      await dispose()
    }
  })
})
