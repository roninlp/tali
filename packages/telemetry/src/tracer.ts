import { Context, Data, Exit, Option, Tracer } from 'effect'
import {
  exportableSpanAttribute,
  exportableSpanAttributes,
} from './redaction.js'

/**
 * Wraps a `Tracer` so nothing unsafe reaches its exporter.
 *
 * The wrapper sits in front of `OtlpTracer` in the browser, where Foldkit
 * attaches each Command's `args` to its span. Attributes, span links, and
 * events are filtered; a failed span's cause is replaced by a fixed message so
 * an error object cannot carry user text into an `exception.message` event.
 * Span names, ids, timing, and parentage pass through unchanged, so trace
 * propagation still matches the server.
 */

class RedactedFailure extends Data.TaggedError('RedactedFailure')<{}> {}

const redactLinks = (
  links: ReadonlyArray<Tracer.SpanLink>,
): ReadonlyArray<Tracer.SpanLink> =>
  links.map(link => ({
    span: link.span,
    attributes: exportableSpanAttributes(link.attributes) ?? {},
  }))

class RedactedSpan implements Tracer.Span {
  readonly _tag = 'Span' as const

  constructor(private readonly inner: Tracer.Span) {}

  get name(): string {
    return this.inner.name
  }

  get spanId(): string {
    return this.inner.spanId
  }

  get traceId(): string {
    return this.inner.traceId
  }

  get parent(): Option.Option<Tracer.AnySpan> {
    return this.inner.parent
  }

  get annotations(): Context.Context<never> {
    return this.inner.annotations
  }

  get status(): Tracer.SpanStatus {
    return this.inner.status
  }

  get attributes(): ReadonlyMap<string, unknown> {
    return this.inner.attributes
  }

  get links(): ReadonlyArray<Tracer.SpanLink> {
    return this.inner.links
  }

  get sampled(): boolean {
    return this.inner.sampled
  }

  get kind(): Tracer.SpanKind {
    return this.inner.kind
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.inner.end(
      endTime,
      Exit.isSuccess(exit) ? exit : Exit.fail(new RedactedFailure()),
    )
  }

  attribute(key: string, value: unknown): void {
    const safe = exportableSpanAttribute(key, value)
    if (safe !== undefined) {
      this.inner.attribute(key, safe)
    }
  }

  event(
    name: string,
    startTime: bigint,
    attributes?: Record<string, unknown>,
  ): void {
    this.inner.event(name, startTime, exportableSpanAttributes(attributes))
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.inner.addLinks(redactLinks(links))
  }
}

/** A tracer that forwards only exportable attributes to `inner`. */
export const redactTracer = (inner: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: options => new RedactedSpan(inner.span(options)),
  })
