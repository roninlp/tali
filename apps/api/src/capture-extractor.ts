import { Context, Duration, Effect, Layer, Ref, Result, Schedule } from "effect"
import { chat as aiChat } from "@tanstack/ai-effect"
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import {
  CAPTURE_MAX_DRAFTS,
  type CaptureDraft,
  type CaptureId,
  type CaptureServiceError,
  ModelTimeout,
  ModelUnavailable,
  captureDedupeKey,
  normalizeCaptureText,
  toJalaliDateInZone,
  toIsoDate,
  formatJalaliDate
} from "@tali/domain"
import type { UserId, WeekStart } from "@tali/domain"
import { makeDraftTools } from "./capture-tools.js"

/**
 * `Extractor` — the one model run behind a Capture (ADR-0012 §7; ticket #101).
 *
 * The service is a `Context.Service` with two layers:
 *
 * - `ExtractorLive`: TanStack AI plus the OpenAI-compatible adapter for the
 *   OpenCode Go gateway. The base URL, model and key are env bindings; a
 *   missing key is a **typed** `ModelUnavailable` at call time, never an
 *   import-time crash or a layer-build failure.
 * - `ExtractorReplay`: the test/eval layer. It returns a recorded draft list
 *   for a text and never touches the network, so `pnpm test` stays offline.
 *
 * The run has no chat surface: one user message, a Persian system prompt, the
 * five draft tools, `stream: false`, thinking off, a 60-second total budget and
 * one retry.
 */

// ── Config ────────────────────────────────────────────────────────────────

/** The OpenCode Go gateway root. The pay-as-you-go root is different. */
export const DEFAULT_CAPTURE_BASE_URL = "https://opencode.ai/inference/go/openai/v1"
export const DEFAULT_CAPTURE_MODEL = "deepseek-v4.1-flash"
/** A non-generic UA; the gateway rejects the SDK default. */
export const DEFAULT_CAPTURE_USER_AGENT = "tali-capture/0.1"
/**
 * The whole Dissect budget, retry included (ADR-0012 §9).
 *
 * Measured live runs of a one-intent sentence land at 12–23 s, and a
 * three-intent sentence has been seen at 37 s; a 30 s cap turns ordinary
 * gateway variance into a failed Capture. 60 s clears the observed tail while
 * still bounding a runaway tool loop.
 */
export const CAPTURE_TIMEOUT_SECONDS = 60
/**
 * Thinking is off for Dissect (ADR-0012 §7). Extraction is bounded and the
 * default `high` effort adds reasoning tokens to every capture without
 * improving a call against five tight schemas.
 *
 * The OpenCode Go gateway takes `reasoning_effort: "none"` on the Chat
 * Completions wire. The generic OpenAI-compatible adapter has no model catalog,
 * so it cannot map the normalized `reasoning` option to a provider value; the
 * field has to ride `modelOptions`, which the adapter spreads into the request.
 */
export const CAPTURE_MODEL_OPTIONS = { reasoning_effort: "none" } as const

export interface CaptureConfigValue {
  /** `undefined` means the feature is inert: Dissect fails typed, not raw. */
  readonly apiKey: string | undefined
  readonly baseUrl: string
  readonly model: string
}

export class CaptureConfig extends Context.Service<CaptureConfig, CaptureConfigValue>()(
  "CaptureConfig"
) {}

export interface CaptureEnv {
  readonly OPENCODE_API_KEY?: string | undefined
  readonly CAPTURE_BASE_URL?: string | undefined
  readonly CAPTURE_MODEL?: string | undefined
}

/** Resolve the Worker bindings into the extractor's config. */
export const captureConfigOf = (env: CaptureEnv): CaptureConfigValue => ({
  apiKey: env.OPENCODE_API_KEY?.trim() || undefined,
  baseUrl: env.CAPTURE_BASE_URL?.trim() || DEFAULT_CAPTURE_BASE_URL,
  model: env.CAPTURE_MODEL?.trim() || DEFAULT_CAPTURE_MODEL
})

// ── Service contract ──────────────────────────────────────────────────────

export interface ExtractInput {
  readonly userId: UserId
  /** The owning Capture row, for tracing only. */
  readonly captureId: CaptureId
  readonly text: string
  /** The Dissect's "now", an ISO instant. */
  readonly now: string
  /** The owner's IANA zone, from server-side preferences (ADR-0002). */
  readonly timeZone: string
  /** The display week start; part of the reproducible prompt. */
  readonly weekStart: WeekStart
}

export interface ExtractorApi {
  readonly dissect: (
    input: ExtractInput
  ) => Effect.Effect<ReadonlyArray<CaptureDraft>, CaptureServiceError>
}

export class Extractor extends Context.Service<Extractor, ExtractorApi>()("Extractor") {}

// ── Prompt ────────────────────────────────────────────────────────────────

const WEEK_START_LABELS: Readonly<Record<WeekStart, string>> = {
  saturday: "شنبه",
  sunday: "یکشنبه",
  monday: "دوشنبه"
}

/**
 * The Persian system prompt. It is built from server-side context so a test
 * can reproduce the same prompt: "today" is the owner's wall date, not UTC's,
 * and the Jalali date is shown alongside the ISO date.
 */
export const captureSystemPrompt = (input: ExtractInput): string => {
  const today = toJalaliDateInZone(new Date(input.now), input.timeZone)
  const todayIso = toIsoDate(today)
  const todayJalali = formatJalaliDate(today, { style: "long" })

  return [
    "تو «تجزیه‌کننده‌ی کپچر» تالی هستی. متن فارسی کاربر را می‌خوانی و فقط با فراخوانی ابزارها، ردیف‌های پیشنهادی می‌سازی. چت نمی‌کنی و پاسخ متنی نمی‌دهی.",
    "",
    `امروز: ${todayIso} (${todayJalali})`,
    `منطقه‌ی زمانی: ${input.timeZone}`,
    `شروع هفته: ${WEEK_START_LABELS[input.weekStart]}`,
    "",
    "قواعد الزامی:",
    "۱. برای هر نیت مستقل دقیقاً یک فراخوانی ابزار بزن. دو نیت را در یک پیش‌نویس ادغام نکن و هیچ نیتی را جا نینداز. مثال: «فردا ساعت ۵ دکتر دارم و یادم باشه قرص رو بگیرم» دو پیش‌نویس است: یک رویداد دکتر و یک یادآور قرص.",
    "۲. هیچ تاریخ، ساعت، تکرار یا زمان یادآوری‌ای را که در متن نیست از خودت نساز. اگر برای کامل‌شدن پیش‌نویس لازم است و متن آن را نگفته، در آرایه‌ی missing یک ورودی با field، shape و question فارسی بگذار. shape یکی از instant، localDate، clockTime، frequency یا repeat است.",
    "۳. sourceQuote باید دقیقاً یک برش لفظی از متن کاربر باشد؛ بازنویسی، خلاصه یا ترجمه ممنوع.",
    "۴. عنوان و متن را با کلمات خود کاربر بنویس و بازنویسی نکن. عنوان کوتاه اما وفادار باشد.",
    "۵. پیش‌فرض‌های بی‌صدا فقط برای فیلدهای قابل ویرایش روی کارت: وضعیت کار todo؛ رویدادی که روز دارد ولی ساعت ندارد allDay؛ kind یادآور general؛ عادتی که ریتم ندارد daily. هیچ تاریخ/ساعت/تکرار دیگری را پیش‌فرض نگیر.",
    "۶. حداکثر ۱۲ پیش‌نویس. اگر متن بیشتر از این دارد، نیت‌های مرتبط را در یک پیش‌نویس ادغام کن، نه اینکه از سقف رد شوی.",
    "۷. متن غیرقابل‌اقدام یا یک ایده را به‌صورت یک note بده: عنوان از خط اول، body کل متن به‌صورت متن ساده (نه ProseMirror).",
    "۸. فقط task، event، note، habit و reminder بساز. فهرست، آیتم فهرست، مناسبت، پروژه، برچسب، ویرایش ردیف موجود و پیوند به ردیف موجود ممنوع است.",
    "۹. تاریخ‌ها YYYY-MM-DD، لحظه‌ها ISO با Z (یا با offset که سرور به UTC تبدیل می‌کند)، ساعت‌ها HH:mm.",
    "۱۰. اگر متن هیچ نیت قابل‌اقدامی ندارد، یک note با کل متن بساز؛ سکوت نتیجه نیست.",
    "",
    "راهنمای فیلدها:",
    "- draft_task: title؛ در صورت وجود description، status، priority، dueDate یا dueAt، recurrence. اگر فقط روز گفته شده dueDate بگذار؛ اگر ساعت هم گفته شده dueAt.",
    "- draft_event: title و timing (timed با start/end یا allDay با date)؛ location، people، recurrence در صورت وجود.",
    "- draft_note: title و body متن ساده.",
    "- draft_habit: title و frequency (daily/weekdays/weekly) فقط اگر متن گفته باشد؛ reminderTime اگر ساعت محلی گفته شده.",
    "- draft_reminder: title، kind و repeat؛ برای once اگر fireAt در متن نیست، آن را در missing بگذار.",
    "",
    "برای هر پیش‌نویس، missing را حتی وقتی خالی است بفرست. نام فیلد در missing باید دقیقاً یکی از این‌ها باشد: dueDate، dueAt، timing، timing.start، timing.end، repeat، repeat.time، frequency، fireAt، reminderTime. برای رویداد از timing.start و timing.end استفاده کن، نه startTime/endTime."
  ].join("\n")
}

// ── Live layer ────────────────────────────────────────────────────────────

const sessionIdFor = (userId: string): Effect.Effect<string, ModelUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(userId)
      const digest = await crypto.subtle.digest("SHA-256", bytes)
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
      return `ses_${hex.slice(0, 32)}`
    },
    catch: (error) =>
      new ModelUnavailable({
        message: `could not derive the OpenCode session id: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
  })

/**
 * The gateway needs the session header on every request, and it rejects a
 * generic User-Agent. `wrapFetch` is the adapter's middleware point, so both
 * ride every request the SDK makes (including retries).
 */
const captureFetchWrapper = (config: { readonly apiKey: string; readonly sessionId: string }) =>
  (next: typeof fetch): typeof fetch =>
    (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${config.apiKey}`)
      headers.set("x-opencode-session", config.sessionId)
      headers.set("user-agent", DEFAULT_CAPTURE_USER_AGENT)
      return next(input, { ...init, headers })
    }

const toModelError = (error: unknown): ModelTimeout | ModelUnavailable => {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "TimeoutError"
  ) {
    return new ModelTimeout({ seconds: CAPTURE_TIMEOUT_SECONDS })
  }
  return new ModelUnavailable({
    message: error instanceof Error ? error.message : String(error)
  })
}

export const ExtractorLive = Layer.effect(
  Extractor,
  Effect.gen(function*() {
    const config = yield* CaptureConfig

    const dissect = (
      input: ExtractInput
    ): Effect.Effect<ReadonlyArray<CaptureDraft>, CaptureServiceError> =>
      Effect.gen(function*() {
        if (config.apiKey === undefined) {
          return yield* Effect.fail(
            new ModelUnavailable({
              message:
                "OPENCODE_API_KEY is not configured; Capture is inert until it is set"
            })
          )
        }

        const apiKey = config.apiKey
        const sessionId = yield* sessionIdFor(input.userId)
        const adapter = openaiCompatibleText(config.model, {
          baseURL: config.baseUrl,
          apiKey,
          api: "chat-completions"
        })

        const attempt = Effect.gen(function*() {
          const collector = yield* Ref.make<ReadonlyArray<CaptureDraft>>([])
          const tools = makeDraftTools(collector, input.text)

          yield* aiChat({
            adapter,
            threadId: `capture-${input.userId}`,
            messages: [{ role: "user", content: input.text }],
            systemPrompts: [captureSystemPrompt(input)],
            tools,
            stream: false as const,
            modelOptions: CAPTURE_MODEL_OPTIONS,
            wrapFetch: captureFetchWrapper({ apiKey, sessionId }),
            // The SDK's error logger prints tool-call `rawArguments`, which are
            // the model's draft payloads: user titles, bodies, quotes, and
            // questions. Workers Logs would keep them for a week. Typed errors
            // and the spans below carry the diagnosis without the text.
            debug: false
          })

          return yield* Ref.get(collector)
        })

        const [modelDuration, modelOutcome] = yield* attempt.pipe(
          // One retry inside a single 60-second total budget (ADR-0012 §9).
          Effect.retry(Schedule.recurs(1)),
          Effect.timeout(Duration.seconds(CAPTURE_TIMEOUT_SECONDS)),
          Effect.mapError(toModelError),
          Effect.result,
          Effect.timed
        )

        const drafts = Result.isSuccess(modelOutcome)
          ? ensureCaptureDrafts(input.text, modelOutcome.success)
          : []

        yield* Effect.annotateCurrentSpan({
          "capture.outcome": Result.isSuccess(modelOutcome) ? "ok" : "failed",
          "capture.model.duration_ms": Math.round(Duration.toMillis(modelDuration)),
          "capture.proposal_count": drafts.length
        })

        if (Result.isFailure(modelOutcome)) {
          return yield* Effect.fail(modelOutcome.failure)
        }
        return drafts
      }).pipe(
        Effect.withSpan("capture.model.call", {
          attributes: {
            "capture.id": input.captureId,
            "capture.model.name": config.model
          }
        })
      )

    return { dissect } as const
  })
)

// ── Replay layer ──────────────────────────────────────────────────────────

/** One recorded Dissect result: the text and the drafts it produced. */
export interface CaptureFixture {
  readonly text: string
  readonly drafts: ReadonlyArray<CaptureDraft>
}

/**
 * The offline Extractor. Fixtures are looked up by the same Persian-folded key
 * the service dedupes on, so a spelling variant still finds its recording.
 */
export const ExtractorReplay = (fixtures: ReadonlyArray<CaptureFixture>): Layer.Layer<Extractor> =>
  Layer.succeed(Extractor, {
    dissect: (input) => {
      const key = captureDedupeKey(input.text)
      const fixture = fixtures.find((candidate) => captureDedupeKey(candidate.text) === key)
      return fixture === undefined
        ? Effect.fail(
          new ModelUnavailable({
            message: `no replay fixture for Capture text: ${input.text}`
          })
        )
        : Effect.succeed(ensureCaptureDrafts(input.text, fixture.drafts))
    }
  })

// ── Shared post-processing ────────────────────────────────────────────────

/**
 * The catch-all of ADR-0012 §10: a run that produced nothing becomes one Note,
 * not a silent drop. The cap is enforced here as a safety net; the prompt asks
 * the model to merge rather than exceed.
 */
export const ensureCaptureDrafts = (
  text: string,
  drafts: ReadonlyArray<CaptureDraft>
): ReadonlyArray<CaptureDraft> =>
  drafts.length > 0
    ? drafts.slice(0, CAPTURE_MAX_DRAFTS)
    : [noteDraftFromText(text)]

/** A Note draft for non-actionable prose: title from the first line. */
export const noteDraftFromText = (text: string): CaptureDraft => {
  const body = normalizeCaptureText(text)
  const title = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "یادداشت"
  return {
    _tag: "note",
    title,
    body,
    sourceQuote: body === "" ? text : body,
    missing: []
  }
}
