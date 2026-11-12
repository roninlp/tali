// Tali infrastructure as code — Alchemy v2 (the `alchemy` npm package).
//
// One stack, two ways to run it:
//
//   alchemy dev                    → everything local, no Cloudflare account
//   alchemy deploy --stage prod    → D1 + api Worker + web static assets
//
// `alchemy dev` runs the api Worker in workerd on :8787 against a local D1
// simulator (migrations applied on every reconcile), and spawns the web app's
// own Vite dev server on :3001. `alchemy deploy` provisions the real thing: D1
// with the same migrations, the api Worker, and the built SPA assets
// (`vite build` → dist) uploaded to the web Worker.
//
// Paths are resolved from this file, not the working directory, so the stack
// behaves the same whether it starts under Turbo (`infra/`) or from the repo
// root with `--config infra/alchemy.run.ts`.
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import {
  CRON,
  CRON_EXPRESSIONS,
  DEFAULT_CAPTURE_BASE_URL,
  DEFAULT_CAPTURE_MODEL,
} from '@tali/config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicKeyOf } from '../scripts/lib/vapid.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `alchemy deploy` keeps state in the Cloudflare state store (a Worker in the
 * account). `alchemy dev` has no account to bootstrap it into, so the same
 * stack persists local state under `.alchemy/state` instead. The CLI sets
 * `ALCHEMY_DEV=true` on the process that evaluates this module.
 */
const isDev =
  process.env.ALCHEMY_DEV === 'true' || process.env.ALCHEMY_DEV === '1'
const state = isDev ? Alchemy.localState() : Cloudflare.state()

/** The household database. Migrations under packages/sql are applied on deploy and on every dev reconcile. */
export const Database = Cloudflare.D1.Database('TaliDatabase', {
  migrations: join(repoRoot, 'packages/sql/migrations'),
})

/**
 * Nightly D1 backups (ticket #85).
 *
 * The api Worker dumps D1 into this bucket and keeps a 14-day window; the
 * bucket's lifecycle rule is a second, longer safety net (30 days) in case the
 * Worker is ever down long enough to miss its own cleanup. The dump is built by
 * the Worker rather than the provider export endpoint because D1 cannot export
 * a database containing FTS5 virtual tables (`notes_fts`). See
 * `docs/adr/0009-nightly-backup-and-trash-purge.md`.
 *
 * The bucket has no public access and no extra API token: the Worker reaches it
 * through an `r2_bucket` binding, the same way it reaches D1.
 *
 * R2 must be enabled on the account before the bucket can exist (a dashboard
 * agreement, not an API call). `TALI_BACKUPS=off` deploys an environment
 * without backup storage — no bucket, no `BACKUP_BUCKET` binding, no nightly
 * backup trigger — which is what a throwaway testing stage on an account
 * without R2 needs. The default stays on, so a normal deploy keeps #85's
 * guarantee.
 */
const backupsEnabled = process.env.TALI_BACKUPS !== 'off'

export const Backups = backupsEnabled
  ? Cloudflare.R2.Bucket('TaliBackups', {
      lifecycleRules: [
        {
          id: 'expire-stale-backups',
          prefix: 'backups/',
          deleteObjectsTransition: {
            condition: { type: 'Age', maxAge: 30 * 24 * 60 * 60 },
          },
        },
      ],
    })
  : undefined

/**
 * VAPID identity (ticket #61; RFC 8292).
 *
 * The private key is a **Workers Secret** supplied out of band; the public key
 * and subject are ordinary config. No key pair is committed to this repository,
 * not even for development: a private key in git is a leaked key, and a
 * published "dev" pair that a deploy can fall back to is worse (it would sign
 * production pushes with a key the world has).
 *
 * Generate one locally (docs/web-push-local.md §1):
 *
 * ```sh
 * pnpm exec web-push generate-vapid-keys
 * export VAPID_PRIVATE_KEY=…      # keep it out of the repo
 * export VAPID_SUBJECT=mailto:you@example.com
 * pnpm dev
 * ```
 *
 * Only the private key needs to be supplied: the public half is derived with
 * Node's ECDH (this file runs at deploy time, not in the Worker) by the shared
 * helper in `scripts/lib/vapid.mjs`, the same one `test:push` uses. With no key
 * in a local run, dispatch is disabled (the ledger still records the inbox
 * row); a deploy without one fails instead of silently shipping an inbox-only
 * app.
 */
const VAPID_DEV_SUBJECT = 'mailto:dev@tali.local'

const resolveVapid = () => {
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? ''
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? ''
  const subject = process.env.VAPID_SUBJECT?.trim() ?? ''

  if (privateKey === '') {
    if (!isDev) {
      throw new Error(
        'VAPID_PRIVATE_KEY is required to deploy: generate one with ' +
          '`pnpm exec web-push generate-vapid-keys` and export it (a Workers secret ' +
          'in CI). See docs/web-push-local.md §1.',
      )
    }
    console.warn(
      '[tali] VAPID_PRIVATE_KEY is not set: push dispatch is disabled and every ' +
        'reminder is inbox-only. Generate a dev pair with ' +
        '`pnpm exec web-push generate-vapid-keys` and export it before `pnpm dev`.',
    )
    return { privateKey: '', publicKey: '', subject: '' }
  }

  if (subject === '' && !isDev) {
    throw new Error(
      'VAPID_SUBJECT is required to deploy (a mailto: or https: contact URI; ' +
        'Apple rejects localhost subjects). See docs/web-push-local.md §1.',
    )
  }

  return {
    privateKey,
    publicKey: publicKey === '' ? publicKeyOf(privateKey) : publicKey,
    // A local mailto is enough for a dev push service.
    subject: subject === '' ? VAPID_DEV_SUBJECT : subject,
  }
}

/**
 * The api Worker — a plain `async fetch` module (no Effect worker bridge), so
 * `env.DB` is the native `D1Database` the app already speaks through
 * `@effect/sql-d1`. The dev port is pinned because the web app's CORS
 * allow-list and `API_URL` default both point at :8787.
 *
 * `crons` is the reminder clock (ADR-0005 §1, #61): one per-minute trigger on
 * this Worker, handled by the module's `scheduled()` export. Alchemy attaches
 * the schedule at deploy time; `alchemy dev` runs no cron triggers, which is
 * why the app also exposes the dev-only `POST /dev/reminders/sweep` route
 * (`DEV_ROUTES=1` below, never set on a deploy).
 *
 * Ticket #85 adds two nightly triggers: purge at 03:17 UTC and backup at 03:47
 * UTC. They are separate invocations so each stays inside D1's per-invocation
 * query budget; the backup runs after the purge, so it captures the pruned
 * database. The expressions and the Worker's dispatch share
 * `@tali/config`'s `CRON_EXPRESSIONS`, so the two cannot drift.
 */
/**
 * Capture model config (ticket #101; ADR-0012 §7).
 *
 * The key is a Workers Secret supplied out of band; the Go base URL and the
 * paid model id are ordinary vars, defaulted from `@tali/config` so the deploy
 * stack cannot disagree with the Worker. The feature is inert without the key:
 * the Worker still builds and every Dissect fails with a typed
 * `ModelUnavailable`, so a deploy without Capture credentials is a warning,
 * not a broken stack.
 */
const resolveCapture = () => {
  const apiKey = process.env.OPENCODE_API_KEY?.trim() ?? ''
  const baseUrl =
    process.env.CAPTURE_BASE_URL?.trim() || DEFAULT_CAPTURE_BASE_URL
  const model = process.env.CAPTURE_MODEL?.trim() || DEFAULT_CAPTURE_MODEL

  if (apiKey === '') {
    console.warn(
      '[tali] OPENCODE_API_KEY is not set: Capture is inert and every Dissect ' +
        'fails with a typed ModelUnavailable. Set it (a Workers secret in CI) ' +
        'to enable the feature.',
    )
  }

  return { apiKey, baseUrl, model }
}

/**
 * Workers Observability (ticket #102 follow-up).
 *
 * Traces are head-sampled at the edge. This is a household app, so 10% keeps
 * the Capture flow inspectable without paying for every polling request;
 * `TALI_TRACE_SAMPLE_RATE` raises or lowers it. Each captured request keeps its
 * whole waterfall: browser -> api server span -> Capture spans -> model fetch
 * and every D1 statement Cloudflare auto-instruments.
 *
 * Trace retention is seven days in Workers Observability. Stored traces start
 * contributing to Cloudflare's ingestion and storage billing on
 * 2026-12-01; sampling is the lever.
 *
 * `TALI_TRACE_PROPAGATION=accept` asks Cloudflare to adopt the browser's
 * incoming `traceparent`, so the browser Command spans and the api spans share
 * one trace ID. That feature must be enabled on the account first; it is off by
 * default because an account without it rejects the setting.
 */
const TRACE_DEFAULT_SAMPLE_RATE = 0.1

const resolveTraceSampleRate = (): number => {
  const raw = process.env.TALI_TRACE_SAMPLE_RATE?.trim()
  if (raw === undefined || raw === '') return TRACE_DEFAULT_SAMPLE_RATE
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `TALI_TRACE_SAMPLE_RATE must be a number from 0 to 1 (got "${raw}")`,
    )
  }
  return parsed
}

const resolveTracePropagation = (): 'accept' | 'authenticated' | undefined => {
  const raw = process.env.TALI_TRACE_PROPAGATION?.trim().toLowerCase()
  if (raw === undefined || raw === '') return undefined
  if (raw !== 'accept' && raw !== 'authenticated') {
    throw new Error(
      `TALI_TRACE_PROPAGATION must be "accept" or "authenticated" (got "${raw}")`,
    )
  }
  return raw
}

/**
 * Optional OTLP export. Every value is opt-in and no endpoint or token is
 * committed; when a URL is absent no destination exists and the Worker keeps
 * dashboard-only observability.
 */
const otlpHeaders = (
  raw: string | undefined,
  variable: string,
): Record<string, Redacted.Redacted<string>> | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${variable} must be a JSON object of header names to values`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${variable} must be a JSON object of header names to values`,
    )
  }
  const headers: Record<string, Redacted.Redacted<string>> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`${variable}.${key} must be a string`)
    }
    headers[key] = Redacted.make(value)
  }
  return headers
}

interface ObservabilityOptions {
  readonly headSamplingRate: number
  readonly propagationPolicy?: 'accept' | 'authenticated'
  readonly traceDestinations: ReadonlyArray<string>
  readonly logDestinations: ReadonlyArray<string>
}

const defineApi = (
  vapid: ReturnType<typeof resolveVapid>,
  capture: ReturnType<typeof resolveCapture>,
  observability: ObservabilityOptions,
) =>
  Cloudflare.Worker('TaliApi', {
    main: join(repoRoot, 'apps/api/src/index.ts'),
    // `nodejs_compat` is the default from 2026-08-04, so the flag is redundant;
    // newer workerd builds reject it outright instead of warning.
    compatibility: { date: '2026-10-09' },
    // Smart Placement runs this isolate near the D1 primary. A screen issues
    // ~11 sequential statements, so a cross-region hop is paid eleven times.
    placement: { mode: 'smart' },
    dev: { port: 8787, strictPort: true },
    observability: {
      enabled: true,
      // Query strings are not part of the Capture flow and can carry user input.
      redactQueryString: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        ...(observability.logDestinations.length === 0
          ? {}
          : { destinations: [...observability.logDestinations] }),
      },
      traces: {
        enabled: true,
        headSamplingRate: observability.headSamplingRate,
        // Keep the waterfall in the Workers dashboard; an OTLP destination is an
        // additional copy, not a replacement.
        persist: true,
        ...(observability.propagationPolicy === undefined
          ? {}
          : { propagationPolicy: observability.propagationPolicy }),
        ...(observability.traceDestinations.length === 0
          ? {}
          : { destinations: [...observability.traceDestinations] }),
      },
    },
    crons: backupsEnabled ? [...CRON_EXPRESSIONS] : [CRON.reminder, CRON.purge],
    env: {
      DB: Database,
      // Nightly backup target and its window (ticket #85). The bucket is private;
      // the Worker writes through the binding, so no API token is involved.
      ...(backupsEnabled
        ? {
            BACKUP_BUCKET: Backups,
            BACKUP_DATABASE_NAME: 'tali',
            BACKUP_RETENTION_DAYS: '14',
          }
        : {}),
      // Plain config (public by design); the private keys bind as secrets.
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_SUBJECT: vapid.subject,
      VAPID_PRIVATE_KEY: Redacted.make(vapid.privateKey),
      CAPTURE_BASE_URL: capture.baseUrl,
      CAPTURE_MODEL: capture.model,
      ...(capture.apiKey === ''
        ? {}
        : { OPENCODE_API_KEY: Redacted.make(capture.apiKey) }),
      DEV_ROUTES: isDev ? '1' : '0',
    },
  })

export default Alchemy.Stack(
  'tali',
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const tracesUrl = process.env.TALI_OTLP_TRACES_URL?.trim()
    const logsUrl = process.env.TALI_OTLP_LOGS_URL?.trim()

    const tracesDestination =
      tracesUrl === undefined || tracesUrl === ''
        ? undefined
        : yield* Cloudflare.Workers.ObservabilityDestination('TaliOtlpTraces', {
            url: tracesUrl,
            headers: otlpHeaders(
              process.env.TALI_OTLP_TRACES_HEADERS,
              'TALI_OTLP_TRACES_HEADERS',
            ),
            logpushDataset: 'opentelemetry-traces',
            skipPreflightCheck:
              process.env.TALI_OTLP_TRACES_SKIP_PREFLIGHT === '1',
          })

    const logsDestination =
      logsUrl === undefined || logsUrl === ''
        ? undefined
        : yield* Cloudflare.Workers.ObservabilityDestination('TaliOtlpLogs', {
            url: logsUrl,
            headers: otlpHeaders(
              process.env.TALI_OTLP_LOGS_HEADERS,
              'TALI_OTLP_LOGS_HEADERS',
            ),
            logpushDataset: 'opentelemetry-logs',
            skipPreflightCheck:
              process.env.TALI_OTLP_LOGS_SKIP_PREFLIGHT === '1',
          })

    const traceDestinations =
      tracesDestination === undefined
        ? []
        : [yield* yield* tracesDestination.slug]
    const logDestinations =
      logsDestination === undefined ? [] : [yield* yield* logsDestination.slug]

    const Api = defineApi(resolveVapid(), resolveCapture(), {
      headSamplingRate: resolveTraceSampleRate(),
      propagationPolicy: resolveTracePropagation(),
      traceDestinations,
      logDestinations,
    })
    const database = yield* Database
    const backups = Backups === undefined ? undefined : yield* Backups
    const api = yield* Api

    /**
     * The web SPA. Deploy runs the package's own `vite build` and uploads
     * `dist` as static assets with SPA fallback. In dev the build is skipped
     * and Vite serves the app itself on the port the app's config pins
     * (:3001), which is what the api Worker's `DEV_ORIGIN` expects.
     *
     * Deployed, the SPA and the api share one origin: `/api/*` is routed
     * worker-first into `apps/web-foldkit/worker.ts`, which strips the prefix
     * and forwards over the `API` service binding. That is what makes the
     * session cookie same-origin and lets the client carry a relative
     * `VITE_API_URL`, so the build does not bake in the deployment's hostname.
     */
    const web = yield* Cloudflare.Website.StaticSite('TaliWeb', {
      cwd: join(repoRoot, 'apps/web-foldkit'),
      main: join(repoRoot, 'apps/web-foldkit/worker.ts'),
      command: 'pnpm run build',
      outdir: 'dist',
      dev: {
        command: 'pnpm exec vite',
        url: 'http://localhost:3001',
        // Alchemy's sidecar defaults to NODE_ENV=production, and Vite derives
        // `import.meta.env.DEV` (and its own dev mode) from that. A dev server
        // must run as development or the app thinks it is a production build.
        env: { NODE_ENV: 'development' },
      },
      assets: {
        notFoundHandling: 'single-page-application',
        // `/api/*` reaches the service binding. `/assets/*` is worker-first
        // only to detect a stale client asking for a removed hash: the asset
        // layer answers it with the SPA shell, and the Worker turns that into a
        // cache-clearing module instead of a blank page.
        runWorkerFirst: ['/api/*', '/assets/*'],
        // Vite hashes /assets/* filenames, so a copy is immutable for a year.
        // The shell entry points and the service worker must never be cached:
        // a client that kept the previous deployment's index.html asks for old
        // asset hashes, and the Worker's asset fallback turns that into a
        // cache-clearing module instead of a blank page. Add future rules here
        // rather than in public/.
        headers:
          '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n' +
          '/\n  Cache-Control: no-store\n' +
          '/index.html\n  Cache-Control: no-store\n' +
          '/sw.js\n  Cache-Control: no-store\n',
      },
      env: {
        ...(isDev ? {} : { VITE_API_URL: '/api' }),
        API: api,
      },
    })

    return {
      database: database.databaseName,
      backupBucket: backups?.bucketName,
      captureTracesDestination: tracesDestination?.slug,
      captureLogsDestination: logsDestination?.slug,
      apiUrl: api.url,
      webUrl: web.url,
    }
  }),
)
