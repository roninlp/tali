import { AsyncLocalStorage } from 'node:async_hooks'
import { Cause, Exit, Option, Tracer } from 'effect'
import { exportableSpanAttribute } from '@tali/telemetry'

/**
 * An Effect `Tracer` backed by Cloudflare Workers Observability.
 *
 * `Workers Traces` auto-instrument fetch handlers, outbound HTTP, and D1
 * binding calls. This tracer mirrors Effect's own spans (`http.span`, SQL,
 * `capture.*`) into the same waterfall through `tracing.startActiveSpan`, so a
 * Capture shows the model call, each D1 statement, and the commit in one place.
 *
 * Cloudflare decides parentage from the async context, and the API runs Effect
 * on its own scheduler, so the tracer carries the invocation's
 * `AsyncLocalStorage` snapshot and re-enters each parent span's snapshot when a
 * child is created. Build one per request: a tracer cached across requests
 * would parent every span to the first invocation.
 *
 * Attribute forwarding is filtered by `@tali/telemetry`; Effect-local spans
 * still hold their full attributes in memory, but only exportable ones reach
 * Workers Observability.
 */

type SpanOptions = Parameters<Tracer.Tracer['span']>[0]
type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>
type CloudflareWorkers = typeof import('cloudflare:workers')
type CloudflareSpan = ReturnType<CloudflareWorkers['tracing']['startSpan']>

/**
 * Started at module evaluation, matching Alchemy's own tracer: on workerd the
 * import is already settled before the first event; under Node (service tests,
 * deploy tooling) it rejects and the tracer simply keeps spans Effect-local.
 * The rejection is handled here so it can never surface as an unhandled one.
 */
const cloudflareWorkers: Promise<CloudflareWorkers | undefined> =
  import('cloudflare:workers').catch(() => undefined)

class CloudflareWorkerSpan extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly runInContext: RunInContext,
    private readonly cloudflareSpan?: CloudflareSpan,
  ) {
    super({
      ...options,
      sampled: options.sampled && (cloudflareSpan?.isTraced ?? false),
    })
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value)
    const safe = exportableSpanAttribute(key, value)
    if (safe !== undefined) {
      this.cloudflareSpan?.setAttribute(key, safe)
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    if (this.cloudflareSpan === undefined) return
    const failed = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    this.cloudflareSpan.setAttribute(
      'effect.exit',
      Exit.isSuccess(exit)
        ? 'success'
        : Cause.hasInterruptsOnly(exit.cause)
          ? 'interrupted'
          : 'failure',
    )
    if (failed) {
      this.cloudflareSpan.setStatus({ code: 'error' })
    }
    this.cloudflareSpan.end()
  }
}

/** A tracer that mirrors Effect spans into this invocation's Workers trace. */
export const makeCloudflareTracer = async (): Promise<Tracer.Tracer> => {
  const tracing = (await cloudflareWorkers)?.tracing
  const invocationContext = AsyncLocalStorage.snapshot()
  const contextFor = (span: Tracer.AnySpan | undefined): RunInContext => {
    let current = span
    while (current?._tag === 'Span') {
      if (current instanceof CloudflareWorkerSpan) return current.runInContext
      current = Option.getOrUndefined(current.parent)
    }
    return invocationContext
  }

  return Tracer.make({
    span(options) {
      const parentContext = options.root
        ? invocationContext
        : contextFor(Option.getOrUndefined(options.parent))

      if (!options.sampled || tracing?.startActiveSpan === undefined) {
        return new CloudflareWorkerSpan(options, parentContext)
      }

      return parentContext(() =>
        tracing.startActiveSpan(
          options.name,
          span =>
            new CloudflareWorkerSpan(
              options,
              AsyncLocalStorage.snapshot(),
              span,
            ),
        ),
      )
    },
    context(primitive, fiber) {
      return contextFor(fiber.cache.span)(() =>
        primitive['~effect/Effect/evaluate'](fiber),
      )
    },
  })
}
