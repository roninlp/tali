/**
 * Where the api Worker lives.
 *
 * Development: the Vite dev server on :3001 proxies `/auth`, `/health`,
 * `/household`, `/month`, `/preferences`, `/push`, `/reminders`, `/rpc`,
 * `/search`, `/sync`, `/today`, and `/week` to the Worker on :8787 (see
 * `vite.config.ts`). The
 * browser therefore stays on its own origin, which keeps cookies same-origin
 * and avoids widening the Worker's CORS allowlist. The Effect RPC client needs
 * an absolute URL, so this is `location.origin` rather than an empty string.
 *
 * Deploy: set `VITE_API_URL=/api`; the static site forwards `/api/*` over the
 * `API` service binding.
 */
const configured = import.meta.env.VITE_API_URL?.trim()

const pageOrigin = globalThis.location?.origin ?? 'http://localhost:3001'

/**
 * Whether this bundle is the Vite dev server.
 *
 * Use `MODE`, not `DEV`: Alchemy starts the dev command with
 * `NODE_ENV=production` (its sidecar default), and Vite derives `DEV`/`PROD`
 * from `NODE_ENV`. `MODE` follows the CLI mode instead, so development stays
 * development even when the parent process says production.
 */
export const isDevServer = import.meta.env.MODE !== 'production'

export const API_URL =
  configured === undefined || configured === ''
    ? isDevServer
      ? pageOrigin
      : new URL('/api', pageOrigin).toString().replace(/\/$/, '')
    : new URL(configured, pageOrigin).toString().replace(/\/$/, '')
