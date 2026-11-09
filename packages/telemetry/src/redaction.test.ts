import { describe, expect, it } from 'vitest'
import { Effect, Tracer } from 'effect'
import {
  exportableSpanAttribute,
  isExportableSpanAttributeKey,
} from './redaction.js'
import { redactTracer } from './tracer.js'

const PERSIAN_TEXT = 'فردا ساعت ۵ دکتر دارم'

describe('span attribute redaction', () => {
  it('drops the names Foldkit puts on a Capture Command span', () => {
    expect(exportableSpanAttribute('text', PERSIAN_TEXT)).toBeUndefined()
    expect(
      exportableSpanAttribute('drafts', [{ title: PERSIAN_TEXT }]),
    ).toBeUndefined()
    expect(exportableSpanAttribute('captureId', 'cap-1')).toBeUndefined()
  })

  it('keeps the attributes this codebase instruments', () => {
    expect(exportableSpanAttribute('capture.id', 'cap-1')).toBe('cap-1')
    expect(exportableSpanAttribute('capture.proposal_count', 3)).toBe(3)
    expect(exportableSpanAttribute('capture.outcome', 'ok')).toBe('ok')
    expect(exportableSpanAttribute('capture.model.duration_ms', 1200)).toBe(
      1200,
    )
    expect(exportableSpanAttribute('http.request.method', 'POST')).toBe('POST')
    expect(exportableSpanAttribute('http.response.status_code', 200)).toBe(200)
    expect(exportableSpanAttribute('effect.exit', 'success')).toBe('success')
  })

  it('drops sensitive keys inside an allowed namespace', () => {
    expect(
      isExportableSpanAttributeKey('http.request.header.authorization'),
    ).toBe(false)
    expect(isExportableSpanAttributeKey('http.request.header.cookie')).toBe(
      false,
    )
    expect(isExportableSpanAttributeKey('db.query.text')).toBe(false)
    expect(isExportableSpanAttributeKey('db.statement')).toBe(false)
    expect(isExportableSpanAttributeKey('capture.text_length')).toBe(false)
  })

  it('strips a URL query string and fragment', () => {
    expect(
      exportableSpanAttribute(
        'url.full',
        'https://api.example.com/rpc?q=secret#x',
      ),
    ).toBe('https://api.example.com/rpc')
  })

  it('drops non-scalar values', () => {
    expect(
      exportableSpanAttribute('capture.draft_payload', { title: PERSIAN_TEXT }),
    ).toBeUndefined()
    expect(
      exportableSpanAttribute('capture.payload', { title: PERSIAN_TEXT }),
    ).toBeUndefined()
  })
})

const recordingTracer = (spans: Array<Tracer.NativeSpan>): Tracer.Tracer =>
  Tracer.make({
    span: options => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })

describe('redactTracer', () => {
  it('forwards only exportable attributes and no user text', async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const program = Effect.void.pipe(
      Effect.withSpan('DissectCapture', {
        attributes: {
          text: PERSIAN_TEXT,
          drafts: [{ title: PERSIAN_TEXT }],
          captureId: 'cap-1',
          'capture.id': 'cap-1',
          'http.request.method': 'POST',
        },
      }),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provideService(
          Tracer.Tracer,
          redactTracer(recordingTracer(spans)),
        ),
      ),
    )

    expect(spans).toHaveLength(1)
    const attributes = Object.fromEntries(spans[0]!.attributes)
    expect(attributes).toEqual({
      'capture.id': 'cap-1',
      'http.request.method': 'POST',
    })
    expect(JSON.stringify(attributes)).not.toContain(PERSIAN_TEXT)
  })

  it('redacts event attributes and a failure cause', async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const program = Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      span.event('exception', 0n, {
        'exception.message': PERSIAN_TEXT,
        'exception.type': 'Error',
      })
      return yield* Effect.fail(new Error(PERSIAN_TEXT))
    }).pipe(
      Effect.withSpan('CommitCapture'),
      Effect.catch(() => Effect.void),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provideService(
          Tracer.Tracer,
          redactTracer(recordingTracer(spans)),
        ),
      ),
    )

    const span = spans[0]!
    expect(span.name).toBe('CommitCapture')
    expect(JSON.stringify([...span.attributes])).not.toContain(PERSIAN_TEXT)
    expect(
      JSON.stringify(span.events.map(([, , attributes]) => attributes)),
    ).not.toContain(PERSIAN_TEXT)
  })
})
