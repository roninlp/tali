import { Effect, Schema } from 'effect'

import type {
  Capture,
  CaptureCommitResult,
  CaptureDraft,
  CaptureId,
} from '@tali/domain'

import { withRpcClient } from './rpc'

/**
 * The typed client for the Capture RPC procedures (ticket #101).
 *
 * The service is network-only, so failures are values the page can render and
 * retry: a stable code, a Persian message, and an optional retry window for
 * the rate limiter. The composer text never lives only in this module.
 */

export const CaptureFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Int),
})
export type CaptureFailure = typeof CaptureFailure.Type

export type CaptureApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CaptureFailure }

const tagOf = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && '_tag' in error
    ? String(error._tag)
    : undefined

const messageFor = (tag: string | undefined): string => {
  switch (tag) {
    case 'CaptureTooLong':
      return 'متن بیش از ۴۰۰۰ کاراکتر است.'
    case 'CaptureEmpty':
      return 'برای تجزیه، اول چیزی بنویس.'
    case 'CaptureRateLimited':
      return 'سهم ساعتی کپچر تمام شده است؛ کمی بعد دوباره تلاش کن.'
    case 'ModelUnavailable':
      return 'مدل در دسترس نیست. متن تو حفظ شده است؛ دوباره تلاش کن.'
    case 'ModelTimeout':
      return 'مدل در ۳۰ ثانیه پاسخ نداد. متن تو حفظ شده است؛ دوباره تلاش کن.'
    case 'InvalidDraft':
      return 'یکی از پیشنویس‌ها با قالب کارت جور نیست؛ عنوان یا فیلد ساختاری را اصلاح کن.'
    case 'DraftIncomplete':
      return 'یکی از کارت‌ها هنوز Needs Input دارد؛ اول آن را پاسخ بده.'
    case 'CaptureNotFound':
      return 'این کپچر پیدا نشد.'
    case 'CaptureForbidden':
      return 'برای کپچر باید عضو یک خانه باشی.'
    case 'Unauthorized':
      return 'نشست منقضی شده است؛ دوباره وارد شو.'
    default:
      return 'ارتباط با سرور برقرار نشد. متن تو حفظ شده است؛ دوباره تلاش کن.'
  }
}

export const captureFailureOf = (error: unknown): CaptureFailure => {
  const tag = tagOf(error)
  const rawRetry =
    error !== null && typeof error === 'object' && 'retryAfterSeconds' in error
      ? Number(error.retryAfterSeconds)
      : undefined
  const retryAfterSeconds =
    rawRetry !== undefined && Number.isFinite(rawRetry) ? rawRetry : undefined
  return {
    code: tag ?? 'Network',
    message: messageFor(tag),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
}

const run = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<CaptureApiResult<A>> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error: captureFailureOf(error) }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  )

export const dissectCapture = (input: { readonly text: string }) =>
  run(withRpcClient((client) => client.DissectCapture(input)))

export const commitCapture = (input: {
  readonly captureId: CaptureId
  readonly drafts: ReadonlyArray<CaptureDraft>
}) => run(withRpcClient((client) => client.CommitCapture(input)))

export const listCaptures = (input: { readonly limit?: number } = {}) =>
  run(withRpcClient((client) => client.ListCaptures(input)))

/** The result strip's rows are links; the page maps the type to a route. */
export type CaptureCreatedRow = Capture['createdIds'][number]
export type CaptureCommitOutcome = CaptureCommitResult
