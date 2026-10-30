/**
 * Where the api Worker lives.
 *
 * Development: the Vite dev server on :3001 proxies `/auth`, `/health`,
 * `/household`, `/push`, `/rpc`, and `/sync` to the Worker on :8787 (see
 * `vite.config.ts`). The browser therefore stays on its own origin, which
 * keeps cookies same-origin and avoids widening the Worker's CORS allowlist.
 * The Effect RPC client needs an absolute URL, so this is `location.origin`
 * rather than an empty string.
 *
 * Deploy: set `VITE_API_URL=/api`; the static site forwards `/api/*` over the
 * `API` service binding, matching the legacy Solid app's setup.
 */
const configured = import.meta.env.VITE_API_URL?.trim()

const pageOrigin = globalThis.location?.origin ?? 'http://localhost:3001'

export const API_URL =
  configured === undefined || configured === ''
    ? import.meta.env.DEV
      ? pageOrigin
      : new URL('/api', pageOrigin).toString().replace(/\/$/, '')
    : new URL(configured, pageOrigin).toString().replace(/\/$/, '')
