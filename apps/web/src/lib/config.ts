/**
 * Where the API Worker lives.
 *
 * In development the browser talks to `wrangler dev` on :8787 and the web app
 * runs on :3000; in production the Worker is reverse-proxied at the same
 * origin, so `VITE_API_URL` is left unset and the relative origin is used.
 */
export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787"
