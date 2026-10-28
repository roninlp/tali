/**
 * Where the API Worker lives.
 *
 * In development the browser talks to the api Worker on :8787 and the web app
 * runs on :3000, so the default is that absolute origin.
 *
 * A deploy sets `VITE_API_URL=/api`: the SPA and the api Worker share one
 * origin, with the web Worker forwarding `/api/*` over a service binding (see
 * `apps/web/worker.ts`). The relative value is resolved against the page's own
 * origin **at runtime**, not at build time, for two reasons: the same build
 * then works on any hostname (a stage URL, `workers.dev`, a custom domain),
 * and the Effect RPC client needs an absolute URL (`HttpClientRequest` parses
 * it with `new URL`).
 */
const configured = import.meta.env.VITE_API_URL?.trim()

const origin = globalThis.location?.origin ?? "http://localhost:3000"

export const API_URL =
  configured === undefined || configured === ""
    ? "http://localhost:8787"
    : new URL(configured, origin).toString().replace(/\/$/, "")
